const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 游戏房间管理
const rooms = new Map();

// 生成房间ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 生成玩家ID
function generatePlayerId() {
    return Math.random().toString(36).substring(2, 10);
}

// 创建新游戏状态
function createGameState() {
    return {
        phase: 'waiting', // waiting, ready, playing, ended
        players: [],
        chambers: [false, false, false, false, false, false],
        bulletPositions: [], // 多子弹位置数组
        bulletCount: 1, // 默认1发子弹
        currentChamber: 0,
        currentPlayerIndex: 0,
        rounds: 0,
        history: [],
        message: '等待玩家加入...'
    };
}

// 广播房间状态给所有玩家
function broadcastRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const gameState = {
        phase: room.game.phase,
        players: room.game.players.map(p => ({
            id: p.id,
            name: p.name,
            isHost: p.isHost,
            isAlive: p.isAlive,
            isReady: p.isReady,
            isCurrent: room.game.players[room.game.currentPlayerIndex]?.id === p.id
        })),
        currentChamber: room.game.currentChamber,
        rounds: room.game.rounds,
        history: room.game.history,
        message: room.game.message
    };

    const message = JSON.stringify({
        type: 'gameState',
        data: gameState
    });

    room.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    });
}

// WebSocket 连接处理
wss.on('connection', (ws) => {
    console.log('新玩家连接');

    let currentRoom = null;
    let currentPlayer = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('收到消息:', data.type);

            switch (data.type) {
                case 'createRoom':
                    // 创建房间
                    const roomId = generateRoomId();
                    const playerId = generatePlayerId();
                    
                    currentRoom = roomId;
                    currentPlayer = playerId;
                    
                    const newRoom = {
                        id: roomId,
                        game: createGameState(),
                        players: [{
                            id: playerId,
                            name: data.playerName || '玩家1',
                            ws: ws,
                            isHost: true,
                            isAlive: true,
                            isReady: false
                        }]
                    };
                    
                    newRoom.game.players = newRoom.players;
                    rooms.set(roomId, newRoom);
                    
                    ws.send(JSON.stringify({
                        type: 'roomCreated',
                        data: { roomId, playerId }
                    }));
                    
                    broadcastRoom(roomId);
                    console.log(`房间 ${roomId} 已创建`);
                    break;

                case 'joinRoom':
                    // 加入房间
                    const joinRoomId = data.roomId?.toUpperCase();
                    const room = rooms.get(joinRoomId);
                    
                    if (!room) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '房间不存在' }
                        }));
                        return;
                    }
                    
                    if (room.game.phase !== 'waiting') {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '游戏已开始，无法加入' }
                        }));
                        return;
                    }
                    
                    if (room.players.length >= 6) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '房间已满' }
                        }));
                        return;
                    }
                    
                    const joinPlayerId = generatePlayerId();
                    currentRoom = joinRoomId;
                    currentPlayer = joinPlayerId;
                    
                    const newPlayer = {
                        id: joinPlayerId,
                        name: data.playerName || `玩家${room.players.length + 1}`,
                        ws: ws,
                        isHost: false,
                        isAlive: true,
                        isReady: false
                    };
                    
                    room.players.push(newPlayer);
                    room.game.players = room.players;
                    
                    ws.send(JSON.stringify({
                        type: 'roomJoined',
                        data: { roomId: joinRoomId, playerId: joinPlayerId }
                    }));
                    
                    broadcastRoom(joinRoomId);
                    console.log(`玩家加入房间 ${joinRoomId}`);
                    break;

                case 'ready':
                    // 玩家准备
                    if (!currentRoom || !currentPlayer) return;
                    const readyRoom = rooms.get(currentRoom);
                    if (!readyRoom) return;
                    
                    const readyPlayer = readyRoom.players.find(p => p.id === currentPlayer);
                    if (readyPlayer) {
                        readyPlayer.isReady = true;
                        
                        // 检查是否所有玩家都准备了
                        const allReady = readyRoom.players.every(p => p.isReady);
                        if (allReady && readyRoom.players.length >= 2) {
                            readyRoom.game.phase = 'ready';
                            readyRoom.game.message = '所有玩家已准备，等待房主设置子弹数量并开始游戏';
                        } else {
                            readyRoom.game.message = `等待其他玩家准备... (${readyRoom.players.filter(p => p.isReady).length}/${readyRoom.players.length})`;
                        }
                        
                        broadcastRoom(currentRoom);
                    }
                    break;

                case 'setBulletCount':
                    // 设置子弹数量（只有房主可以）
                    if (!currentRoom || !currentPlayer) return;
                    const bulletRoom = rooms.get(currentRoom);
                    if (!bulletRoom) return;
                    
                    const bulletPlayer = bulletRoom.players.find(p => p.id === currentPlayer);
                    if (!bulletPlayer?.isHost) return;
                    
                    if (bulletRoom.game.phase !== 'ready') {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '只能在准备阶段设置子弹数量' }
                        }));
                        return;
                    }
                    
                    const count = parseInt(data.count);
                    if (count < 1 || count > 5) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '子弹数量必须在1-5之间' }
                        }));
                        return;
                    }
                    
                    bulletRoom.game.bulletCount = count;
                    bulletRoom.game.message = `房主设置了 ${count} 发子弹，点击开始游戏`;
                    
                    ws.send(JSON.stringify({
                        type: 'bulletCountSet',
                        data: { count: count }
                    }));
                    
                    broadcastRoom(currentRoom);
                    console.log(`房间 ${currentRoom} 设置了 ${count} 发子弹`);
                    break;

                case 'startGame':
                    // 开始游戏（只有房主可以）
                    if (!currentRoom || !currentPlayer) return;
                    const startRoom = rooms.get(currentRoom);
                    if (!startRoom) return;
                    
                    const startPlayer = startRoom.players.find(p => p.id === currentPlayer);
                    if (!startPlayer?.isHost) return;
                    
                    if (startRoom.players.length < 2) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '至少需要2名玩家' }
                        }));
                        return;
                    }
                    
                    // 初始化游戏
                    startRoom.game.phase = 'playing';
                    startRoom.game.chambers = [false, false, false, false, false, false];
                    startRoom.game.bulletPositions = [];
                    
                    // 根据设置的子弹数量填充弹仓
                    const bulletCount = startRoom.game.bulletCount || 1;
                    const positions = [0, 1, 2, 3, 4, 5];
                    // 随机打乱位置
                    for (let i = positions.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [positions[i], positions[j]] = [positions[j], positions[i]];
                    }
                    // 填充子弹
                    for (let i = 0; i < bulletCount; i++) {
                        startRoom.game.chambers[positions[i]] = true;
                        startRoom.game.bulletPositions.push(positions[i]);
                    }
                    
                    startRoom.game.currentChamber = 0;
                    startRoom.game.currentPlayerIndex = Math.floor(Math.random() * startRoom.players.length);
                    startRoom.game.rounds = 0;
                    startRoom.game.history = [];
                    
                    const firstPlayer = startRoom.game.players[startRoom.game.currentPlayerIndex];
                    const actualBulletCount = startRoom.game.bulletPositions.length;
                    startRoom.game.message = `游戏开始！${actualBulletCount}发子弹已装填，${firstPlayer.name} 先开枪`;
                    
                    broadcastRoom(currentRoom);
                    console.log(`房间 ${currentRoom} 游戏开始，${actualBulletCount}发子弹`);
                    break;

                case 'fire':
                    // 扣动扳机
                    if (!currentRoom || !currentPlayer) return;
                    const fireRoom = rooms.get(currentRoom);
                    if (!fireRoom || fireRoom.game.phase !== 'playing') return;
                    
                    const currentGamePlayer = fireRoom.game.players[fireRoom.game.currentPlayerIndex];
                    if (currentGamePlayer.id !== currentPlayer) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '还没轮到你' }
                        }));
                        return;
                    }
                    
                    fireRoom.game.rounds++;
                    const hasBullet = fireRoom.game.chambers[fireRoom.game.currentChamber];
                    
                    if (hasBullet) {
                        // 中弹死亡
                        currentGamePlayer.isAlive = false;
                        
                        fireRoom.game.history.push({
                            round: fireRoom.game.rounds,
                            player: currentGamePlayer.name,
                            result: 'dead',
                            chamber: fireRoom.game.currentChamber + 1
                        });
                        
                        // 检查是否只剩一个存活玩家
                        const alivePlayers = fireRoom.players.filter(p => p.isAlive);
                        
                        if (alivePlayers.length <= 1) {
                            // 游戏结束
                            fireRoom.game.phase = 'ended';
                            const winner = alivePlayers[0];
                            // 记录赢家ID和名字
                            if (winner) {
                                fireRoom.lastWinnerId = winner.id;
                                fireRoom.lastWinnerName = winner.name;
                            }
                            fireRoom.game.message = winner 
                                ? `💥 ${currentGamePlayer.name} 死了！${winner.name} 获胜！点击"下一局"开始新游戏` 
                                : `💥 ${currentGamePlayer.name} 死了！同归于尽！`;
                        } else {
                            // 继续游戏，跳过死亡玩家
                            fireRoom.game.message = `💥 ${currentGamePlayer.name} 中弹身亡！`;
                            
                            // 找到下一个存活的玩家
                            do {
                                fireRoom.game.currentPlayerIndex = (fireRoom.game.currentPlayerIndex + 1) % fireRoom.players.length;
                            } while (!fireRoom.game.players[fireRoom.game.currentPlayerIndex].isAlive);
                            
                            const nextPlayer = fireRoom.game.players[fireRoom.game.currentPlayerIndex];
                            fireRoom.game.message += ` 轮到 ${nextPlayer.name}`;
                            
                            // 重新装弹旋转
                            fireRoom.game.currentChamber = 0;
                            fireRoom.game.chambers = [false, false, false, false, false, false];
                            fireRoom.game.bulletPositions = [];
                            
                            // 重新随机填充子弹
                            const newPositions = [0, 1, 2, 3, 4, 5];
                            for (let i = newPositions.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [newPositions[i], newPositions[j]] = [newPositions[j], newPositions[i]];
                            }
                            const newBulletCount = fireRoom.game.bulletCount || 1;
                            for (let i = 0; i < newBulletCount; i++) {
                                fireRoom.game.chambers[newPositions[i]] = true;
                                fireRoom.game.bulletPositions.push(newPositions[i]);
                            }
                        }
                    } else {
                        // 存活
                        fireRoom.game.history.push({
                            round: fireRoom.game.rounds,
                            player: currentGamePlayer.name,
                            result: 'survived',
                            chamber: fireRoom.game.currentChamber + 1
                        });
                        
                        fireRoom.game.currentChamber++;
                        
                        if (fireRoom.game.currentChamber >= 6) {
                            // 所有弹仓都是空的，奇迹生还
                            fireRoom.game.message = `🔘 ${currentGamePlayer.name} 奇迹般生还！重新装弹...`;
                            fireRoom.game.currentChamber = 0;
                            fireRoom.game.chambers = [false, false, false, false, false, false];
                            fireRoom.game.bulletPositions = [];
                            
                            // 重新随机填充子弹
                            const newPositions2 = [0, 1, 2, 3, 4, 5];
                            for (let i = newPositions2.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [newPositions2[i], newPositions2[j]] = [newPositions2[j], newPositions2[i]];
                            }
                            const newBulletCount2 = fireRoom.game.bulletCount || 1;
                            for (let i = 0; i < newBulletCount2; i++) {
                                fireRoom.game.chambers[newPositions2[i]] = true;
                                fireRoom.game.bulletPositions.push(newPositions2[i]);
                            }
                        } else {
                            fireRoom.game.message = `🔘 ${currentGamePlayer.name} 存活！`;
                        }
                        
                        // 轮到下一个存活的玩家
                        do {
                            fireRoom.game.currentPlayerIndex = (fireRoom.game.currentPlayerIndex + 1) % fireRoom.players.length;
                        } while (!fireRoom.game.players[fireRoom.game.currentPlayerIndex].isAlive);
                        
                        const nextPlayer = fireRoom.game.players[fireRoom.game.currentPlayerIndex];
                        fireRoom.game.message += ` 轮到 ${nextPlayer.name}`;
                    }
                    
                    broadcastRoom(currentRoom);
                    break;

                case 'resetGame':
                    // 重置游戏（只有房主可以）
                    if (!currentRoom || !currentPlayer) return;
                    const resetRoom = rooms.get(currentRoom);
                    if (!resetRoom) return;
                    
                    const resetPlayer = resetRoom.players.find(p => p.id === currentPlayer);
                    if (!resetPlayer?.isHost) return;
                    
                    // 重置所有玩家状态
                    resetRoom.players.forEach(p => {
                        p.isAlive = true;
                        p.isReady = false;
                    });
                    
                    resetRoom.game = createGameState();
                    resetRoom.game.players = resetRoom.players;
                    
                    broadcastRoom(currentRoom);
                    console.log(`房间 ${currentRoom} 游戏重置`);
                    break;

                case 'nextGame':
                    // 开始下一局（赢家成为新房主并设置子弹）
                    if (!currentRoom || !currentPlayer) return;
                    const nextRoom = rooms.get(currentRoom);
                    if (!nextRoom) return;
                    
                    // 检查是否是上一局的赢家
                    if (nextRoom.lastWinnerId && nextRoom.lastWinnerId !== currentPlayer) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '只有赢家可以开始下一局' }
                        }));
                        return;
                    }
                    
                    // 赢家成为房主
                    nextRoom.players.forEach(p => {
                        p.isHost = (p.id === currentPlayer);
                        p.isAlive = true;
                        p.isReady = false;
                    });
                    
                    nextRoom.game = createGameState();
                    nextRoom.game.players = nextRoom.players;
                    nextRoom.game.phase = 'ready'; // 直接进入准备阶段，让赢家设置子弹
                    nextRoom.game.message = `${nextRoom.lastWinnerName || '赢家'}请设置子弹数量`;
                    
                    broadcastRoom(currentRoom);
                    console.log(`房间 ${currentRoom} 开始下一局，赢家 ${nextRoom.lastWinnerName} 设置子弹`);
                    break;

                case 'chat':
                    // 聊天消息
                    if (!currentRoom || !currentPlayer) return;
                    const chatRoom = rooms.get(currentRoom);
                    if (!chatRoom) return;
                    
                    const chatPlayer = chatRoom.players.find(p => p.id === currentPlayer);
                    if (!chatPlayer) return;
                    
                    const chatMessage = {
                        type: 'chat',
                        data: {
                            player: chatPlayer.name,
                            message: data.message,
                            time: new Date().toLocaleTimeString()
                        }
                    };
                    
                    chatRoom.players.forEach(p => {
                        if (p.ws.readyState === WebSocket.OPEN) {
                            p.ws.send(JSON.stringify(chatMessage));
                        }
                    });
                    break;
            }
        } catch (err) {
            console.error('消息处理错误:', err);
        }
    });

    ws.on('close', () => {
        console.log('玩家断开连接');
        
        if (currentRoom && currentPlayer) {
            const room = rooms.get(currentRoom);
            if (room) {
                // 移除玩家
                const playerIndex = room.players.findIndex(p => p.id === currentPlayer);
                if (playerIndex > -1) {
                    const player = room.players[playerIndex];
                    room.players.splice(playerIndex, 1);
                    room.game.players = room.players;
                    
                    // 如果房间空了，删除房间
                    if (room.players.length === 0) {
                        rooms.delete(currentRoom);
                        console.log(`房间 ${currentRoom} 已删除`);
                    } else {
                        // 如果房主离开，转让房主
                        if (player.isHost && room.players.length > 0) {
                            room.players[0].isHost = true;
                        }
                        
                        // 如果游戏进行中，检查是否结束
                        if (room.game.phase === 'playing') {
                            const alivePlayers = room.players.filter(p => p.isAlive);
                            if (alivePlayers.length <= 1) {
                                room.game.phase = 'ended';
                                room.game.message = alivePlayers.length === 1 
                                    ? `${alivePlayers[0].name} 获胜！` 
                                    : '所有玩家都已离开';
                            }
                        }
                        
                        room.game.message = `${player.name} 离开了房间`;
                        broadcastRoom(currentRoom);
                    }
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log(`本地访问: http://localhost:${PORT}`);
});
