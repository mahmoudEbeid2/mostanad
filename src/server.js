import http from "http";
import app from "./app.js";
import { initSocketServer } from "./lib/socket.js";

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
initSocketServer(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT} bound to 0.0.0.0`);
});

