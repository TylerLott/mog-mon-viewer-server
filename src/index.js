import express from "express"

const PORT = 80

const app = express()

// This server should do Oauth for google
app.use((req, res, next) => {
  // validate
  next()
})

// This server should also read data from Redis and send to users
app.get("/currentStats", (req, res) => {
  //
})

// This server should recieve team-updates from the main ws-server and update the Redis server with teams
app.post("/mainwebsocket", (req, res) => {
  //
})

app.listen(PORT, () => {
  console.log(`listening on port ${PORT}`)
})
