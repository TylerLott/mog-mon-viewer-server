import express from "express"
import http from "http"
import cors from "cors"
import { Server } from "socket.io"
import { createClient } from "redis"
import jwt_decode from "jwt-decode"

let PORT = 80
let PATH = "/api/viewer"
let REDIS_PATH = "redis://34.228.17.8:6379"
if (process.env.NODE_ENV !== "production") {
  PORT = 7000
  PATH = ""
  REDIS_PATH = "redis://34.228.17.8:6379"
}

// SETUP
const app = express()
const server = http.createServer(app)

let io
if (process.env.NODE_ENV !== "production") {
  app.use(cors)
  io = new Server(server, {
    cors: {
      oriign: "*",
      methods: ["GET", "POST"],
    },
    path: PATH,
  })
} else {
  io = new Server(server, { path: PATH })
}
app.io = io
;(async () => {
  ////////////////////////////////////////////////////////////
  // connect
  ////////////////////////////////////////////////////////////
  const redisPub = createClient({ url: REDIS_PATH })
  const redisSub = redisPub.duplicate()
  ////////////////////////////////////////////////////////////
  // error
  ////////////////////////////////////////////////////////////
  redisPub.on("error", (err) => {
    console.log("not connected to redis", err)
  })
  redisSub.on("error", (err) => {
    console.log("not connected to redis", err)
  })
  ////////////////////////////////////////////////////////////
  // ready
  ////////////////////////////////////////////////////////////
  redisPub.on("ready", () => {
    console.log("redis pub connected successfully")
  })
  redisSub.on("ready", () => {
    console.log("redis sub connected successfully")
  })
  await redisPub.connect()
  await redisSub.connect()
  ////////////////////////////////////////////////////////////
  // SUBSCRIBE
  //  - channels only hold the last value
  //       - so channels are used to notify of redis changes
  //       - signal server should update redis, then publish to channel
  ////////////////////////////////////////////////////////////
  await redisSub.subscribe("teams", (teams, chan) => {
    // emite teams to teams
    if (teams) {
      io.emit("add-teams", JSON.parse(teams))
      // for each team
      const t = JSON.parse(teams) // teams is an arr
      console.log("teams", t)
      if (Array.isArray(t)) {
        t.forEach(async (team) => {
          // subscribe to team
          await redisSub.subscribe(`${team.name}`, async (count, chan) => {
            // when team changes, get from key and emit to all
            let cnt = await redisPub.get(team.name)
            // if no count, set to 0 and emit 0
            if (!cnt) {
              cnt = 0
              redisPub.set(team.name, cnt)
            }
            io.emit("update-count", { team: chan, val: cnt })
          })
        })
      }
    }
  })
  await redisSub.subscribe("players", (players, chan) => {
    io.emit("players", JSON.parse(players)) // players is an arr
  })

  await redisSub.subscribe("settings", (settings, chan) => {
    let sets = JSON.parse(settings)
    io.emit("settings", sets)
    redisPub.set("settings", settings)
  })
  await redisSub.subscribe("team-timeouts", (teams, chan) => {
    let t = JSON.parse(teams) // {team: teamname, count: count}
    if (t.val === 0) {
      redisPub.set(t.team, 0)
    }
  })

  ////////////////////////////////////////////////////////////
  // SOCKET SETUP
  ////////////////////////////////////////////////////////////
  console.log("setting up io connection")
  io.on("connection", async (socket) => {
    console.log("connection", socket.handshake.headers)
    let userId
    // auth with amzn headers
    try {
      let j = socket.handshake.headers["x-amzn-oidc-data"]
      j = jwt_decode(j)
      userId = j.client
    } catch (e) {
      socket.disconnect()
      userId = "testuser"
    }

    // auth
    let t = await redisPub.get("teams")
    t = JSON.parse(t)
    if (t) {
      console.log("emitting teams", t)
      socket.emit("add-teams", t)
    }
    t.forEach(async (team) => {
      let c = await redisPub.get(team.name)
      socket.emit("update-count", { team: team.name, val: c })
    })
    let p = await redisPub.get("players")
    if (p) {
      socket.emit("add-players", JSON.parse(p))
    }
    let s = await redisPub.get("settings")
    if (s) {
      socket.emit("settings", JSON.parse(s))
    }

    socket.on("attack", async (attack) => {
      // get attack from socket
      // do auth stuff first
      // check if user is timed-out
      let time = await redisPub.get(userId)
      let sett = await redisPub.get("settings")
      sett = JSON.parse(sett)
      let userTimeout = sett.timeout
      let thresh = sett.thresh
      if (time && parseInt(time) + userTimeout > Date.now()) {
        // stop attack
        socket.emit("set-waiting", parseInt(time) + userTimeout)
      } else {
        await redisPub.set(userId, Date.now())
        // check if the team exists and is able to be attacked
        let cnt = await redisPub.get(attack.team)
        if (cnt && parseInt(cnt) < thresh) {
          await redisPub.incr(attack.team)
          redisPub.publish(attack.team, 1)
          socket.emit("set-waiting", Date.now() + userTimeout)
        } else if (!cnt) {
          await redisPub.set(attack.team, 1)
          redisPub.publish(attack.team, 1)
          socket.emit("set-waiting", Date.now() + userTimeout)
        } else {
          let t = Date.now()
          await redisPub.set(attack.team, `time,${t}`)
          redisPub.publish(
            "team-timeouts",
            JSON.stringify({ team: attack.team, val: thresh })
          )
          socket.emit("update-count", { team: attack.team, val: t })
          socket.emit("set-waiting", Date.now() + userTimeout)
        }
      }
    })
  })
  console.log("io", io)
  // LISTEN
  server.listen(PORT, () => {
    console.log(`listening on port ${PORT}`)
  })
})()
