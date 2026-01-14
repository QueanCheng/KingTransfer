# P2P文件传输系统 

## 当前信令服务实现

目前系统使用的是本地Socket.io服务器作为信令服务，具体实现如下：

1. **本地服务器(server.js)**：
   - 使用Express + Socket.io构建
   - 处理房间创建、加入和信令转发
   - 生成二维码供手机端扫描

2. **前端信令流程**：
   - 电脑端和手机端通过Socket.io连接到本地服务器
   - 本地服务器作为中介转发WebRTC信令（SDP offer/answer和ICE候选）
   - WebRTC连接建立后，文件直接在设备间传输

## 将信令服务切换到MemFire Cloud云函数

### 1. 部署MemFire Cloud云函数

首先，你需要在MemFire Cloud上部署信令处理函数：

1. 登录MemFire Cloud控制台
2. 创建一个新的云函数
3. 将`functions/signaling.js`的内容复制到云函数中
4. 部署云函数并获取访问URL

### 2. 修改前端代码

#### 2.1 创建云函数信令服务客户端

创建一个新文件`public/js/memfire-signaling.js`，用于处理与MemFire Cloud云函数的通信：

```javascript
// MemFire Cloud信令服务客户端
class MemFireSignaling {
    constructor(apiUrl) {
        this.apiUrl = apiUrl;
        this.roomId = null;
        this.peerId = Math.random().toString(36).substring(2, 10);
        this.onMessage = null;
        this.pollingInterval = null;
    }

    // 设置消息处理函数
    setOnMessageCallback(callback) {
        this.onMessage = callback;
    }

    // 创建房间
    async createRoom() {
        const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: 'create-room',
                peerId: this.peerId
            })
        });
        const data = await response.json();
        if (data.success) {
            this.roomId = data.roomId;
            this.startPolling();
        }
        return data;
    }

    // 加入房间
    async joinRoom(roomId) {
        this.roomId = roomId;
        const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: 'join-room',
                roomId: roomId,
                peerId: this.peerId
            })
        });
        const data = await response.json();
        if (data.success) {
            this.startPolling();
        }
        return data;
    }

    // 发送信令
    async sendSignal(signal) {
        await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: 'signal',
                roomId: this.roomId,
                peerId: this.peerId,
                signal: signal
            })
        });
    }

    // 开始轮询信令
    startPolling() {
        this.pollingInterval = setInterval(async () => {
            try {
                const response = await fetch(this.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: 'poll',
                        roomId: this.roomId,
                        peerId: this.peerId
                    })
                });
                const data = await response.json();
                if (data.success && data.messages && data.messages.length > 0) {
                    data.messages.forEach(msg => {
                        if (this.onMessage) {
                            this.onMessage(msg);
                        }
                    });
                }
            } catch (error) {
                console.error('轮询信令失败:', error);
            }
        }, 1000);
    }

    // 停止轮询
    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }
}
```

#### 2.2 更新MemFire Cloud云函数

更新`functions/signaling.js`，添加完整的信令处理逻辑：

```javascript
// MemFire Cloud 云函数 - 完整信令服务器

// 存储房间信息（实际部署时应使用数据库）
const rooms = new Map();
// 存储消息队列
const messages = new Map();

export default async function handler(event, context) {
    const { method, body } = event;
    
    if (method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            },
            body: ''
        };
    }
    
    if (method === 'POST') {
        try {
            const data = JSON.parse(body);
            const { action, roomId, peerId, signal } = data;
            
            switch (action) {
                case 'create-room': {
                    const newRoomId = Math.random().toString(36).substring(2, 10);
                    rooms.set(newRoomId, {
                        host: peerId,
                        client: null
                    });
                    messages.set(newRoomId, []);
                    
                    return {
                        statusCode: 200,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            success: true,
                            message: '房间创建成功',
                            roomId: newRoomId
                        })
                    };
                }
                
                case 'join-room': {
                    if (rooms.has(roomId)) {
                        const room = rooms.get(roomId);
                        if (room.client) {
                            return {
                                statusCode: 400,
                                headers: {
                                    'Access-Control-Allow-Origin': '*',
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    success: false,
                                    message: '房间已满'
                                })
                            };
                        }
                        
                        room.client = peerId;
                        
                        // 通知房主有客户端加入
                        if (messages.has(roomId)) {
                            messages.get(roomId).push({
                                type: 'client-joined',
                                from: peerId
                            });
                        }
                        
                        return {
                            statusCode: 200,
                            headers: {
                                'Access-Control-Allow-Origin': '*',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                success: true,
                                message: '成功加入房间'
                            })
                        };
                    } else {
                        return {
                            statusCode: 404,
                            headers: {
                                'Access-Control-Allow-Origin': '*',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                success: false,
                                message: '房间不存在'
                            })
                        };
                    }
                }
                
                case 'signal': {
                    if (rooms.has(roomId)) {
                        const room = rooms.get(roomId);
                        const target = room.host === peerId ? room.client : room.host;
                        
                        if (target && messages.has(roomId)) {
                            messages.get(roomId).push({
                                type: 'signal',
                                from: peerId,
                                signal: signal
                            });
                        }
                        
                        return {
                            statusCode: 200,
                            headers: {
                                'Access-Control-Allow-Origin': '*',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                success: true,
                                message: '信令转发成功'
                            })
                        };
                    } else {
                        return {
                            statusCode: 404,
                            headers: {
                                'Access-Control-Allow-Origin': '*',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                success: false,
                                message: '房间不存在'
                            })
                        };
                    }
                }
                
                case 'poll': {
                    if (rooms.has(roomId) && messages.has(roomId)) {
                        const msgQueue = messages.get(roomId);
                        const peerMessages = msgQueue.filter(msg => 
                            msg.to === peerId || msg.to === undefined
                        );
                        
                        // 从队列中移除已处理的消息
                        const remainingMessages = msgQueue.filter(msg => 
                            !peerMessages.includes(msg)
                        );
                        messages.set(roomId, remainingMessages);
                        
                        return {
                            statusCode: 200,
                            headers: {
                                'Access-Control-Allow-Origin': '*',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                success: true,
                                messages: peerMessages
                            })
                        };
                    } else {
                        return {
                            statusCode: 200,
                            headers: {
                                'Access-Control-Allow-Origin': '*',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                success: true,
                                messages: []
                            })
                        };
                    }
                }
                
                default:
                    return {
                        statusCode: 400,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            success: false,
                            message: '未知操作'
                        })
                    };
            }
        } catch (error) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    success: false,
                    message: '请求格式错误',
                    error: error.message
                })
            };
        }
    }
    
    return {
        statusCode: 405,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Allow': 'POST, OPTIONS'
        },
        body: JSON.stringify({
            success: false,
            message: '方法不允许'
        })
    };
}
```

#### 2.3 修改电脑端页面(index.html)

替换Socket.io相关代码，使用MemFire Cloud信令服务：

```html
<!-- 移除Socket.io脚本 -->
<!-- <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.2/socket.io.min.js"></script> -->
<!-- 添加MemFire信令客户端脚本 -->
<script src="js/memfire-signaling.js"></script>
<script>
    // 替换Socket.io初始化
    // const socket = io();
    const signaling = new MemFireSignaling('https://your-memfire-cloud-function-url');
    
    // 设置信令消息处理
    signaling.setOnMessageCallback((message) => {
        if (message.type === 'client-joined') {
            statusElement.textContent = '手机已连接，准备传输文件...';
            statusElement.className = 'status-success';
            startWebRTC();
        } else if (message.type === 'signal') {
            handleSignal(message);
        }
    });
    
    // 修改生成二维码逻辑
    generateQrButton.addEventListener('click', async () => {
        const result = await signaling.createRoom();
        if (result.success) {
            const clientUrl = `http://${window.location.hostname}:${window.location.port}/client.html?room=${result.roomId}`;
            const qrCodeData = await QRCode.toDataURL(clientUrl);
            qrcodeContainer.innerHTML = `<img src="${qrCodeData}" alt="文件传输二维码">`;
            statusElement.textContent = '二维码已生成，等待手机扫描...';
            statusElement.className = 'status-info';
        }
    });
    
    // 其他相关修改...
</script>
```

#### 2.4 修改手机端页面(client.html)

类似地，更新手机端页面以使用MemFire Cloud信令服务。

### 3. 部署和测试

1. 将更新后的前端代码部署到Web服务器
2. 在MemFire Cloud上部署更新后的云函数
3. 测试整个流程：
   - 电脑端生成二维码
   - 手机端扫描二维码
   - 建立连接并传输文件

## 优势和注意事项

### 优势

1. **无需本地服务器**：不再需要运行本地Node.js服务器
2. **更好的扩展性**：MemFire Cloud云函数可以处理更多并发连接
3. **跨网络支持**：支持不同网络环境下的设备通信
4. **更高的可靠性**：MemFire Cloud提供高可用的云服务

### 注意事项

1. **云函数费用**：MemFire Cloud云函数可能产生费用，请查看其定价策略
2. **轮询延迟**：HTTP轮询可能导致信令延迟，影响连接建立速度
3. **房间管理**：示例中使用内存存储房间信息，实际部署时应使用MemFire Cloud的数据库
4. **安全性**：建议添加身份验证和加密机制，保护信令数据

## 总结

当前系统使用的是本地Socket.io服务器作为信令服务，而不是MemFire Cloud云函数。要启用MemFire Cloud云函数作为信令服务，需要修改前端代码和云函数实现，将Socket.io替换为HTTP请求到MemFire Cloud云函数。

上述步骤提供了完整的集成指南，您可以根据实际情况进行调整和优化。
