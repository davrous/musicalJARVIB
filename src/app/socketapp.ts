// Import required packages
import express from "express";

// WebSocket server part
//const express2 = require('express'); 
const appSocket = express();
const http = require('http');
const serverSocket = http.createServer(appSocket);
const { Server } = require("socket.io");
const socketapp = new Server(serverSocket);

appSocket.use(express.static('public'));

appSocket.get('/', (req: any, res: any) => {
  res.sendFile(__dirname + '/index.html');
});

serverSocket.listen(3000, () => {
  console.log('WebSocket server listening on *:3000');
});

export default socketapp; 