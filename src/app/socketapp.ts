// Socket.IO server for 3D canvas communication
import express from "express";
import http from "http";
import { Server } from "socket.io";

const appSocket = express();
const serverSocket = http.createServer(appSocket);
const socketapp = new Server(serverSocket);

appSocket.use(express.static('public'));

appSocket.get('/', (req: any, res: any) => {
  res.sendFile(__dirname + '/index.html');
});

serverSocket.listen(3000, () => {
  console.log('WebSocket server listening on *:3000');
});

export default socketapp; 