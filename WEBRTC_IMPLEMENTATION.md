# WebRTC P2P文件传输实现详解

## 许可证声明

**MIT License**

Copyright (c) 2026 P2P文件传输系统

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
**except for commercial operation**, to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice, including the restriction
on commercial operation, shall be included in all copies or substantial portions
of the Software.

**Additional Restriction:**

- **Commercial Operation Prohibited:** No person or entity is permitted to use,
  modify, distribute, or sublicense the Software or any derivative works for
  commercial purposes, including but not limited to selling, licensing, or
  using the Software as part of a commercial product or service.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---



## 1. 系统架构

### 1.1 整体架构
```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  电脑端浏览器   │       │  信令服务器     │       │  手机端浏览器   │
│  (WebRTC Host)  │◄─────►│  (Socket.io/    │◄─────►│  (WebRTC Client)│
│                 │       │   MemFire Cloud)│       │                 │
└─────────────────┘       └─────────────────┘       └─────────────────┘
         ▲                                                     ▲
         │                                                     │
         └─────────────────────────────────────────────────────┘
                              WebRTC P2P连接
                              (DataChannel)
```

### 1.2 核心组件

#### 1.2.1 信令服务
- **当前实现**：基于Socket.io的本地服务器
- **功能**：
  - 房间创建与管理
  - WebRTC信令转发（SDP offer/answer和ICE候选）
  - 客户端连接状态管理

#### 1.2.2 WebRTC PeerConnection
- **创建时机**：电脑端在手机连接后创建
- **配置**：使用Google STUN服务器进行NAT穿透
  ```javascript
  pc = new RTCPeerConnection({
      iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
      ]
  });
  ```

#### 1.2.3 DataChannel
- **创建方式**：电脑端主动创建
- **配置**：默认配置，可靠传输
  ```javascript
  dataChannel = pc.createDataChannel('fileTransfer');
  ```

## 2. SDP交换流程

### 2.1 连接建立时序图

```
电脑端                          信令服务器                          手机端
  │                                 │                                 │
  │ 1. 创建PeerConnection           │                                 │
  │    └─ 创建DataChannel           │                                 │
  │ 2. createOffer()                │                                 │
  │ 3. setLocalDescription(offer)   │                                 │
  │ 4. 发送offer信令 ──────────────────►│                                 │
  │                                 │ 5. 转发offer信令 ──────────────────►│
  │                                 │                                 │ 6. setRemoteDescription(offer)
  │                                 │                                 │ 7. createAnswer()
  │                                 │                                 │ 8. setLocalDescription(answer)
  │                                 │ 9. 转发answer信令 ──────────────────┤
  │10. 接收answer信令 ──────────────────┤                                 │
  │11. setRemoteDescription(answer) │                                 │
  │                                 │                                 │
  │12. ICE候选生成                  │                                 │
  │13. 发送ICE候选 ──────────────────►│                                 │
  │                                 │14. 转发ICE候选 ──────────────────►│
  │                                 │                                 │15. addIceCandidate()
  │                                 │                                 │
  │                                 │16. ICE候选生成                  │
  │                                 │17. 转发ICE候选 ──────────────────┤
  │18. 接收ICE候选 ──────────────────┤                                 │
  │19. addIceCandidate()            │                                 │
  │                                 │                                 │
  │20. DataChannel连接建立          │                                 │
  │                                 │                                 │
```

### 2.2 关键代码分析

#### 2.2.1 Offer生成与发送（电脑端）
```javascript
// 创建offer
pc.createOffer().then(offer => {
    return pc.setLocalDescription(offer);
}).then(() => {
    // 通过信令服务器发送offer
    socket.emit('signal', {
        roomId: getRoomId(),
        target: 'client',
        signal: pc.localDescription
    });
});
```

#### 2.2.2 Answer生成与发送（手机端）
```javascript
// 处理offer信令
socket.on('signal', (data) => {
    const { from, signal } = data;
    
    if (signal.type === 'offer') {
        pc.setRemoteDescription(new RTCSessionDescription(signal))
            .then(() => pc.createAnswer())
            .then(answer => pc.setLocalDescription(answer))
            .then(() => {
                // 发送answer信令
                socket.emit('signal', {
                    roomId: currentRoomId,
                    target: from,
                    signal: pc.localDescription
                });
            });
    }
    // ...
});
```

#### 2.2.3 ICE候选处理
```javascript
// ICE候选生成事件处理
pc.onicecandidate = (event) => {
    if (event.candidate) {
        socket.emit('signal', {
            roomId: roomId,
            target: 'peer',
            signal: event.candidate
        });
    }
};

// 处理ICE候选信令
socket.on('signal', (data) => {
    const { signal } = data;
    if (signal.type === 'candidate') {
        pc.addIceCandidate(new RTCIceCandidate(signal));
    }
});
```

## 3. DataChannel文件传输实现

### 3.1 文件传输流程

```
手机端                          电脑端
  │                                 │
  │ 1. 选择文件                     │
  │ 2. 读取文件元数据               │
  │ 3. 发送文件元数据 ──────────────────►│
  │                                 │ 4. 初始化文件接收
  │ 5. 分块读取文件内容             │
  │ 6. 发送文件块 ──────────────────────►│
  │                                 │ 7. 接收并存储文件块
  │ 8. 更新传输进度                 │
  │ 9. 重复步骤5-8直到文件发送完成  │
  │                                 │10. 重组文件块
  │                                 │11. 保存完整文件
  │                                 │
```

### 3.2 关键代码分析

#### 3.2.1 文件分块与发送（手机端）
```javascript
function uploadFile(file, currentIndex, totalFiles) {
    const CHUNK_SIZE = 16384; // 16KB chunks
    let offset = 0;
    
    // 发送文件元数据
    const metadata = {
        type: 'file',
        name: file.name,
        size: file.size
    };
    dataChannel.send(JSON.stringify(metadata));
    
    // 读取文件并发送
    const reader = new FileReader();
    
    reader.onload = (e) => {
        const buffer = e.target.result;
        dataChannel.send(buffer); // 发送文件块
        
        offset += buffer.byteLength;
        // 更新进度...
        
        if (offset < file.size) {
            readNextChunk(); // 继续发送下一块
        }
    };
    
    function readNextChunk() {
        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(chunk); // 读取下一块
    }
    
    readNextChunk(); // 开始发送第一块
}
```

#### 3.2.2 文件接收与重组（电脑端）
```javascript
function handleDataMessage(data) {
    if (typeof data === 'string') {
        // 处理文件元数据
        const metadata = JSON.parse(data);
        if (metadata.type === 'file') {
            currentFile = {
                name: metadata.name,
                size: metadata.size,
                data: [] // 存储文件块
            };
            receivedSize = 0;
            // 初始化进度显示...
        }
    } else {
        // 处理文件块
        if (currentFile) {
            currentFile.data.push(data); // 存储文件块
            receivedSize += data.byteLength;
            
            // 更新进度...
            
            if (receivedSize >= currentFile.size) {
                saveFile(currentFile); // 重组并保存文件
            }
        }
    }
}

// 保存文件
function saveFile(file) {
    const blob = new Blob(file.data); // 重组文件块为Blob
    const url = URL.createObjectURL(blob);
    // 创建下载链接并触发下载...
    URL.revokeObjectURL(url);
}
```

## 4. 实现特点与优化建议

### 4.1 当前实现的特点

| 特点 | 描述 |
|------|------|
| **P2P直连** | 利用WebRTC实现设备间直接连接，无需服务器中转文件 |
| **NAT穿透** | 使用Google STUN服务器实现NAT穿透，支持跨网络传输 |
| **分块传输** | 将文件分块（16KB）传输，提高传输效率 |
| **多文件支持** | 支持同时上传多个文件 |
| **实时进度** | 实时显示文件传输进度 |
| **自动保存** | 接收完成后自动保存文件到本地 |

### 4.2 优化建议

#### 4.2.1 可靠性优化

1. **添加确认机制**
   ```javascript
   // 发送端
   dataChannel.send(JSON.stringify({ type: 'chunk', index: chunkIndex, data: chunkData }));
   
   // 接收端
   dataChannel.send(JSON.stringify({ type: 'ack', index: receivedChunkIndex }));
   ```

2. **实现重传机制**
   ```javascript
   // 发送端维护未确认的块列表
   // 设置超时重传
   setTimeout(() => {
       if (!acknowledged[chunkIndex]) {
           retransmitChunk(chunkIndex);
       }
   }, RETRANSMIT_TIMEOUT);
   ```

3. **添加校验机制**
   ```javascript
   // 发送端计算文件块哈希
   const hash = await crypto.subtle.digest('SHA-256', chunkData);
   dataChannel.send(JSON.stringify({ 
       type: 'chunk', 
       index: chunkIndex, 
       data: chunkData, 
       hash: arrayBufferToHex(hash) 
   }));
   
   // 接收端验证哈希
   const receivedHash = await crypto.subtle.digest('SHA-256', receivedData);
   if (arrayBufferToHex(receivedHash) !== expectedHash) {
       // 请求重传
   }
   ```

#### 4.2.2 性能优化

1. **动态调整分块大小**
   ```javascript
   // 根据网络状况调整分块大小
   let CHUNK_SIZE = 16384;
   
   // 监测网络状况
   setInterval(() => {
       if (networkQuality.good) {
           CHUNK_SIZE = 65536; // 64KB
       } else if (networkQuality.poor) {
           CHUNK_SIZE = 4096; // 4KB
       }
   }, 5000);
   ```

2. **使用Web Workers处理文件**
   ```javascript
   // 使用Web Worker进行文件分块和哈希计算
   const worker = new Worker('file-processor.js');
   worker.postMessage({ type: 'process', file: file, chunkSize: CHUNK_SIZE });
   
   worker.onmessage = (e) => {
       if (e.data.type === 'chunk') {
           dataChannel.send(e.data.chunk);
       }
   };
   ```

3. **优化内存使用**
   ```javascript
   // 对于大文件，使用Blob存储而不是ArrayBuffer数组
   let fileBlob = new Blob();
   
   // 接收文件块时
   fileBlob = new Blob([fileBlob, chunkData]);
   ```

#### 4.2.3 功能增强

1. **支持断点续传**
   ```javascript
   // 发送端
   dataChannel.send(JSON.stringify({ type: 'resume', fileName: fileName, offset: currentOffset }));
   
   // 接收端
   if (fileExists(fileName)) {
       const currentSize = getFileSize(fileName);
       dataChannel.send(JSON.stringify({ type: 'resume-ack', offset: currentSize }));
   }
   ```

2. **添加传输限速**
   ```javascript
   // 实现令牌桶算法进行限速
   class TokenBucket {
       constructor(rate, burst) {
           this.rate = rate; // 令牌生成速率（字节/秒）
           this.burst = burst; // 桶容量（字节）
           this.tokens = burst;
           this.lastRefill = Date.now();
       }
       
       getTokens(bytes) {
           // 计算需要生成的令牌数
           const now = Date.now();
           const elapsed = now - this.lastRefill;
           const tokensToAdd = (elapsed / 1000) * this.rate;
           this.tokens = Math.min(this.burst, this.tokens + tokensToAdd);
           this.lastRefill = now;
           
           if (this.tokens >= bytes) {
               this.tokens -= bytes;
               return true;
           }
           return false;
       }
   }
   ```

3. **支持目录传输**
   ```javascript
   // 发送目录结构
   dataChannel.send(JSON.stringify({
       type: 'directory',
       name: directoryName,
       files: fileList
   }));
   ```

## 5. 测试与调试

### 5.1 浏览器开发者工具

1. **Chrome浏览器**
   - **WebRTC内部信息**：chrome://webrtc-internals/
   - **Network面板**：查看信令服务器连接
   - **Console面板**：查看日志和错误信息
   - **Application面板**：查看DataChannel状态

2. **Firefox浏览器**
   - **WebRTC状态**：about:webrtc
   - **Network Monitor**：查看网络流量
   - **Console**：查看调试信息

### 5.2 常见问题与解决方案

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 无法建立P2P连接 | NAT穿透失败 | 添加TURN服务器 |
| 文件传输中断 | 网络不稳定 | 添加重传机制 |
| 内存占用过高 | 大文件传输 | 优化文件存储方式，使用Blob |
| 传输速度慢 | 分块大小不合理 | 动态调整分块大小 |
| 连接断开 | 信令服务器问题 | 优化信令服务器，添加重连机制 |

## 6. 总结

当前实现成功构建了基于WebRTC的P2P文件传输系统，利用SDP交换建立连接，通过DataChannel进行文件分块传输。系统具有以下优势：

1. **高效**：P2P直连，无需服务器中转，传输速度快
2. **安全**：数据直接在设备间传输，减少中间环节的安全风险
3. **跨平台**：支持不同操作系统和浏览器
4. **易于使用**：扫描二维码即可建立连接
5. **可扩展**：可通过MemFire Cloud云函数实现更强大的信令服务

通过实施上述优化建议，可以进一步提高系统的可靠性、性能和功能，使其更适合生产环境使用。

## 7. 参考资料

1. [WebRTC官方文档](https://webrtc.org/start/)
2. [MDN WebRTC文档](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
3. [WebRTC数据通道教程](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
4. [Socket.io官方文档](https://socket.io/docs/)
5. [MemFire Cloud文档](https://docs.memfiredb.com/)