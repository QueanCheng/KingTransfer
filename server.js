const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// 获取电脑的实际IP地址 - 对于跨网传输，使用公网IP
function getLocalIp() {
    // 对于跨网传输，我们直接返回公网IP地址
    // 这样手机在不同局域网也能访问
    return '47.123.206.157';
}

const localIp = getLocalIp();

// 存储房间信息
const rooms = new Map();

// 存储在线设备
const devices = new Map();

console.log('P2P文件传输系统已启动 - 支持二维码连接');
console.log('电脑端生成二维码，手机端扫描后建立连接');
console.log(`本地IP地址: ${localIp}`);
console.log(`服务器运行在 http://${localIp}:${PORT}`);

// WebSocket服务器用于跨网通信
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log(`新WebSocket连接来自: ${req.connection.remoteAddress}`);
  
  // 生成设备ID
  const deviceId = Math.random().toString(36).substring(2, 15);
  
  // 房间ID
  let roomId = null;
  
  // 设备类型：host(电脑端)或client(手机端)
  let deviceType = null;
  
  // 发送连接确认消息
  ws.send(JSON.stringify({
    type: 'connection-confirmed',
    message: '连接成功，等待进一步操作'
  }));
  
  // 处理消息
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'create-room':
          // 电脑端请求创建房间
          roomId = Math.random().toString(36).substring(2, 10);
          deviceType = 'host';
          
          // 生成客户端URL - 使用电脑的实际IP地址和客户端路径
          const clientUrl = `http://${localIp}:${PORT}/client?room=${roomId}`;
          
          // 存储房间信息
          rooms.set(roomId, {
            host: deviceId,
            client: null,
            hostWs: ws
          });
          
          // 发送房间信息给电脑端，二维码在客户端生成
          ws.send(JSON.stringify({
            type: 'room-created',
            roomId: roomId,
            clientUrl: clientUrl
          }));
          
          console.log(`创建房间: ${roomId}, 客户端URL: ${clientUrl}`);
          break;
          
        case 'join-room':
          // 手机端请求加入房间
          roomId = data.roomId;
          deviceType = 'client';
          
          console.log(`收到加入房间请求: roomId=${roomId}, deviceId=${deviceId}`);
          console.log(`当前房间列表: ${Array.from(rooms.keys())}`);
          
          if (rooms.has(roomId)) {
            const room = rooms.get(roomId);
            if (room.client) {
              // 房间已满
              console.log(`房间 ${roomId} 已满，拒绝加入`);
              ws.send(JSON.stringify({
                type: 'room-full'
              }));
              return;
            }
            
            // 更新房间信息
            room.client = deviceId;
            room.clientWs = ws;
            
            // 通知手机端加入成功
            ws.send(JSON.stringify({
              type: 'joined-room',
              roomId: roomId
            }));
            console.log(`通知手机端 ${deviceId} 加入房间成功`);
            
            // 通知电脑端有客户端加入
            if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
              room.hostWs.send(JSON.stringify({
                type: 'client-joined',
                clientId: deviceId
              }));
              console.log(`通知电脑端 ${room.host} 有客户端加入`);
            }
            
            console.log(`手机端 ${deviceId} 成功加入房间: ${roomId}`);
          } else {
            // 房间不存在
            console.log(`房间 ${roomId} 不存在`);
            ws.send(JSON.stringify({
              type: 'room-not-found'
            }));
          }
          break;
          
        case 'signal':
          // 转发信令
          if (roomId && rooms.has(roomId)) {
            const room = rooms.get(roomId);
            const target = deviceType === 'host' ? room.clientWs : room.hostWs;
            
            if (target && target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify({
                type: 'signal',
                from: deviceId,
                signal: data.signal
              }));
            }
          }
          break;
          
        default:
          console.log('未知消息类型:', data.type);
      }
    } catch (error) {
      console.error('消息处理错误:', error);
    }
  });
  
  // 断开连接
  ws.on('close', () => {
    console.log('WebSocket连接断开');
    
    // 清理房间
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      
      if (deviceType === 'host') {
        // 房主断开连接，通知客户端
        if (room.clientWs && room.clientWs.readyState === WebSocket.OPEN) {
          room.clientWs.send(JSON.stringify({
            type: 'host-disconnected'
          }));
        }
        rooms.delete(roomId);
      } else if (deviceType === 'client') {
        // 客户端断开连接，通知房主
        if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
          room.hostWs.send(JSON.stringify({
            type: 'client-disconnected'
          }));
        }
        room.client = null;
        room.clientWs = null;
      }
      
      console.log(`设备 ${deviceId} 断开连接，房间 ${roomId} 已更新`);
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/client', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log('WebSocket设备发现服务已启动');
    console.log('请在浏览器中打开 http://localhost:3000 开始使用');
});