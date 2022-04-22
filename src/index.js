import express from "express"
import http from "http"
import cors from "cors"
import { Server } from "socket.io"
import { createClient } from "redis"

let PORT = 80
let PATH = "/api/viewer"
let REDIS_PATH = "redis://44.204.86.55:6379"
if (process.env.NODE_ENV !== "production") {
  PORT = 7000
  PATH = ""
  REDIS_PATH = "redis://44.204.86.55:6379"
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
    io.emit("teams", JSON.parse(teams))
    // for each team
    const t = JSON.parse(teams) // teams is an arr
    if (Array.isArray(t)) {
      t.forEach((team) => {
        // subscribe to team
        redisSub.subscribe(`${team.name}`, (count, chan) => {
          console.log(count, team)
          // when team changes, get from key and emit to all
          let cnt = redisPub.get(team.name)
          // if no count, set to 0 and emit 0
          if (!cnt) {
            cnt = 0
            redisPub.set(team.name, cnt)
          }
          io.emit("count-update", { team: chan, val: cnt })
        })
      })
    }
  })
  await redisSub.subscribe("players", (players, chan) => {
    io.emit("players", JSON.parse(players)) // players is an arr
  })

  await redisSub.subscribe("settings", (settings, chan) => {
    console.log("got settings", settings) // settings is an object
    let sets = JSON.parse(settings)
    console.log("sets", sets)
    io.emit("settings", sets)
    redisPub.set("user-timeout", sets.userTimeout)
    redisPub.set("thresh", sets.userTimeout)
  })
  await redisSub.subscribe("team-timeouts", (teams, chan) => {
    let t = JSON.parse(teams) // {team: teamname, count: count}
    if (t.val === 0) {
      redisPub.set(t.team, 0)
    }
  })
  await redisPub.publish("teams", JSON.stringify({ teamTest: "test" }))
  ////////////////////////////////////////////////////////////
  // SOCKET SETUP
  ////////////////////////////////////////////////////////////
  io.on("connection", (socket) => {
    socket.on("attack", (attack) => {
      // get attack from socket
      // do auth stuff first
      // check if user is timed-out
      let time = redisPub.get(attack.userId)
      let userTimeout = redisPub.get("settings")
      userTimeout = JSON.parse(userTimeout).userTimeout
      if (time && parseInt(time) + userTimeout < Date.now()) {
        // stop attack
        socket.emit("timeout", time)
      } else {
        redisPub.set(attack.user, Date.now())
      }
      // check if the team exists and is able to be attacked
      let cnt = redisPub.get(attack.team)
      let thresh = redisPub.get("thresh")
      if (cnt && !isNaN(cnt) && cnt < thresh) {
        redisPub.incr(attack.team)
        redisPub.publish(attack.team, 1)
      } else if (!cnt) {
        redisPub.set(attack.team, 1)
        redisPub.publish(attack.team, 1)
      } else {
        let t = Date.now()
        redisPub.set(attack.team, `time,${t}`)
        redisPub.publish(
          "team-timeouts",
          JSON.stringify({ team: attack.team, count: thresh })
        )
        socket.emit("count-update", { team: attack.team, val: t })
      }
    })
  })
  // LISTEN
  server.listen(PORT, () => {
    console.log(`listening on port ${PORT}`)
  })
})()
