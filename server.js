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

// 玩家数据管理（内存存储，实际应用应该用数据库）
const playerData = new Map();

// 获取或创建玩家数据
function getPlayerData(playerId) {
    if (!playerData.has(playerId)) {
        playerData.set(playerId, {
            coins: 200,           // 初始金币
            debt: 0,              // 借贷金额
            lastWageTime: 0,      // 上次领工资时间
            totalWinnings: 0,     // 总赢金
            totalLosses: 0        // 总输金
        });
    }
    return playerData.get(playerId);
}

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
        phase: 'waiting', // waiting, betting, ready, playing, ended
        players: [],
        chambers: [false, false, false, false, false, false],
        bulletPositions: [],
        bulletCount: 1,
        currentChamber: 0,
        currentPlayerIndex: 0,
        rounds: 0,
        history: [],
        message: '等待玩家加入...',
        pot: 0,               // 奖池
        baseBet: 1,           // 底注
        currentBet: 0         // 当前累加投注
    };
}

// 检查是否可以领工资（24小时冷却）
function canClaimWage(lastWageTime) {
    const now = Date.now();
    const cooldown = 24 * 60 * 60 * 1000; // 24小时
    return now - lastWageTime >= cooldown;
}

// 计算距离下次领工资还有多久
function getWageCooldown(lastWageTime) {
    const now = Date.now();
    const cooldown = 24 * 60 * 60 * 1000;
    const remaining = cooldown - (now - lastWageTime);
    if (remaining <= 0) return 0;
    
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((remaining % (60 * 1000)) / 1000);
    return { hours, minutes, seconds };
}

// 格式化时间
function formatTime(time) {
    if (!time || time === 0) return '00:00:00';
    return `${time.hours.toString().padStart(2, '0')}:${time.minutes.toString().padStart(2, '0')}:${time.seconds.toString().padStart(2, '0')}`;
}

// 广播房间状态给所有玩家
function broadcastRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const gameState = {
        phase: room.game.phase,
        players: room.game.players.map(p => {
            const data = getPlayerData(p.id);
            return {
                id: p.id,
                name: p.name,
                isHost: p.isHost,
                isAlive: p.isAlive,
                isReady: p.isReady,
                isCurrent: room.game.players[room.game.currentPlayerIndex]?.id === p.id,
                coins: data.coins,
                debt: data.debt,
                currentBet: p.currentBet || 0
            };
        }),
        currentChamber: room.game.currentChamber,
        rounds: room.game.rounds,
        history: room.game.history,
        message: room.game.message,
        pot: room.game.pot,
        baseBet: room.game.baseBet,
        currentBet: room.game.currentBet
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
                    const roomId = generateRoomId();
                    const playerId = generatePlayerId();
                    
                    currentRoom = roomId;
                    currentPlayer = playerId;
                    
                    const playerData = getPlayerData(playerId);
                    
                    const newRoom = {
                        id: roomId,
                        game: createGameState(),
                        players: [{
                            id: playerId,
                            name: data.playerName || '玩家1',
                            ws: ws,
                            isHost: true,
                            isAlive: true,
                            isReady: false,
                            currentBet: 0
                        }],
                        lastWinnerId: null,
                        lastWinnerName: null
                    };
                    
                    newRoom.game.players = newRoom.players;
                    rooms.set(roomId, newRoom);
                    
                    ws.send(JSON.stringify({
                        type: 'roomCreated',
                        data: { 
                            roomId, 
                            playerId,
                            playerData: {
                                coins: playerData.coins,
                                debt: playerData.debt,
                                canClaimWage: canClaimWage(playerData.lastWageTime),
                                wageCooldown: formatTime(getWageCooldown(playerData.lastWageTime))
                            }
                        }
                    }));
                    
                    broadcastRoom(roomId);
                    console.log(`房间 ${roomId} 已创建`);
                    break;

                case 'joinRoom':
                    const joinRoomId = data.roomId?.toUpperCase();
                    const room = rooms.get(joinRoomId);
                    
                    if (!room) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '房间不存在' }
                        }));
                        return;
                    }
                    
                    if (room.game.phase !== 'waiting' && room.game.phase !== 'betting') {
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
                    
                    const joinPlayerData = getPlayerData(joinPlayerId);
                    
                    const newPlayer = {
                        id: joinPlayerId,
                        name: data.playerName || `玩家${room.players.length + 1}`,
                        ws: ws,
                        isHost: false,
                        isAlive: true,
                        isReady: false,
                        currentBet: 0
                    };
                    
                    room.players.push(newPlayer);
                    room.game.players = room.players;
                    
                    ws.send(JSON.stringify({
                        type: 'roomJoined',
                        data: { 
                            roomId: joinRoomId, 
                            playerId: joinPlayerId,
                            playerData: {
                                coins: joinPlayerData.coins,
                                debt: joinPlayerData.debt,
                                canClaimWage: canClaimWage(joinPlayerData.lastWageTime),
                                wageCooldown: formatTime(getWageCooldown(joinPlayerData.lastWageTime))
                            }
                        }
                    }));
                    
                    broadcastRoom(joinRoomId);
                    console.log(`玩家加入房间 ${joinRoomId}`);
                    break;

                case 'placeBet':
                    if (!currentRoom || !currentPlayer) return;
                    const betRoom = rooms.get(currentRoom);
                    if (!betRoom) return;
                    
                    // 允许在 waiting、betting、playing 阶段加注
                    if (!['waiting', 'betting', 'playing'].includes(betRoom.game.phase)) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '当前不能投注' }
                        }));
                        return;
                    }
                    
                    // 游戏过程中只能存活玩家加注
                    if (betRoom.game.phase === 'playing') {
                        const bettingPlayer = betRoom.players.find(p => p.id === currentPlayer);
                        if (!bettingPlayer || !bettingPlayer.isAlive) {
                            ws.send(JSON.stringify({
                                type: 'error',
                                data: { message: '死亡玩家不能投注' }
                            }));
                            return;
                        }
                    }
                    
                    const betAmount = parseInt(data.amount);
                    if (![1, 5, 10, 20, 50, 100].includes(betAmount)) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '无效的投注金额' }
                        }));
                        return;
                    }
                    
                    const betPlayerData = getPlayerData(currentPlayer);
                    const totalBet = (betRoom.game.baseBet + betPlayerData.currentBet + betAmount);
                    
                    if (betPlayerData.coins < totalBet) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '金币不足' }
                        }));
                        return;
                    }
                    
                    // 累加投注
                    const player = betRoom.players.find(p => p.id === currentPlayer);
                    if (player) {
                        player.currentBet = (player.currentBet || 0) + betAmount;
                        betRoom.game.currentBet += betAmount;
                        betRoom.game.pot += betAmount;
                    }
                    
                    betRoom.game.phase = 'betting';
                    betRoom.game.message = `投注中... 当前奖池: ${betRoom.game.pot}金币`;
                    
                    ws.send(JSON.stringify({
                        type: 'betPlaced',
                        data: { amount: betAmount, totalBet: player.currentBet }
                    }));
                    
                    broadcastRoom(currentRoom);
                    console.log(`玩家 ${currentPlayer} 投注 ${betAmount}`);
                    break;

                case 'ready':
                    if (!currentRoom || !currentPlayer) return;
                    const readyRoom = rooms.get(currentRoom);
                    if (!readyRoom) return;
                    
                    const readyPlayer = readyRoom.players.find(p => p.id === currentPlayer);
                    if (!readyPlayer) return;
                    
                    // 扣除底注和投注
                    const readyPlayerData = getPlayerData(currentPlayer);
                    const totalDeduction = readyRoom.game.baseBet + (readyPlayer.currentBet || 0);
                    
                    if (readyPlayerData.coins < totalDeduction) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '金币不足，无法准备' }
                        }));
                        return;
                    }
                    
                    readyPlayerData.coins -= totalDeduction;
                    readyRoom.game.pot += readyRoom.game.baseBet;
                    
                    readyPlayer.isReady = true;
                    
                    const allReady = readyRoom.players.every(p => p.isReady);
                    if (allReady && readyRoom.players.length >= 2) {
                        readyRoom.game.phase = 'ready';
                        readyRoom.game.message = `所有玩家已准备，奖池: ${readyRoom.game.pot}金币，等待房主开始`;
                    } else {
                        readyRoom.game.message = `等待其他玩家准备... (${readyRoom.players.filter(p => p.isReady).length}/${readyRoom.players.length})`;
                    }
                    
                    broadcastRoom(currentRoom);
                    break;

                case 'claimWage':
                    if (!currentPlayer) return;
                    const wagePlayerData = getPlayerData(currentPlayer);
                    
                    if (canClaimWage(wagePlayerData.lastWageTime)) {
                        wagePlayerData.coins += 200;
                        wagePlayerData.lastWageTime = Date.now();
                        
                        ws.send(JSON.stringify({
                            type: 'wageClaimed',
                            data: { 
                                coins: wagePlayerData.coins,
                                message: '领取工资成功！获得200金币'
                            }
                        }));
                        
                        if (currentRoom) {
                            broadcastRoom(currentRoom);
                        }
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '工资冷却中，24小时后可再次领取' }
                        }));
                    }
                    break;

                case 'takeLoan':
                    if (!currentPlayer) return;
                    const loanPlayerData = getPlayerData(currentPlayer);
                    
                    if (loanPlayerData.debt + 900 > 10000) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '借贷金额将超过上限10000' }
                        }));
                        return;
                    }
                    
                    loanPlayerData.coins += 900;
                    loanPlayerData.debt += 900;
                    
                    ws.send(JSON.stringify({
                            type: 'loanTaken',
                            data: {
                                coins: loanPlayerData.coins,
                                debt: loanPlayerData.debt,
                                message: '借贷成功！获得900金币，需还1300'
                            }
                        }));
                    
                    if (currentRoom) {
                        broadcastRoom(currentRoom);
                    }
                    break;

                case 'setBulletCount':
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
                    bulletRoom.game.message = `房主设置了 ${count} 发子弹，奖池: ${bulletRoom.game.pot}金币`;
                    
                    ws.send(JSON.stringify({
                        type: 'bulletCountSet',
                        data: { count: count }
                    }));
                    
                    broadcastRoom(currentRoom);
                    break;

                case 'startGame':
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
                    
                    const bulletCount = startRoom.game.bulletCount || 1;
                    const positions = [0, 1, 2, 3, 4, 5];
                    for (let i = positions.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [positions[i], positions[j]] = [positions[j], positions[i]];
                    }
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
                    startRoom.game.message = `游戏开始！${actualBulletCount}发子弹，奖池${startRoom.game.pot}金币，${firstPlayer.name} 先开枪`;
                    
                    broadcastRoom(currentRoom);
                    console.log(`房间 ${currentRoom} 游戏开始`);
                    break;

                case 'fire':
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
                        currentGamePlayer.isAlive = false;
                        
                        fireRoom.game.history.push({
                            round: fireRoom.game.rounds,
                            player: currentGamePlayer.name,
                            result: 'dead',
                            chamber: fireRoom.game.currentChamber + 1
                        });
                        
                        const alivePlayers = fireRoom.players.filter(p => p.isAlive);
                        
                        if (alivePlayers.length <= 1) {
                            fireRoom.game.phase = 'ended';
                            const winner = alivePlayers[0];
                            
                            if (winner) {
                                fireRoom.lastWinnerId = winner.id;
                                fireRoom.lastWinnerName = winner.name;
                                
                                // 赢家获得奖池
                                const winnerData = getPlayerData(winner.id);
                                const pot = fireRoom.game.pot;
                                
                                // 计算还款（如果有债务）
                                let repayment = 0;
                                if (winnerData.debt > 0) {
                                    repayment = Math.floor(pot * 0.35);
                                    const actualRepayment = Math.min(repayment, Math.floor(winnerData.debt * (13/9)));
                                    winnerData.debt = Math.max(0, winnerData.debt - Math.floor(actualRepayment * (9/13)));
                                }
                                
                                const netWinnings = pot - repayment;
                                winnerData.coins += netWinnings;
                                winnerData.totalWinnings += netWinnings;
                                
                                fireRoom.game.message = `💥 ${currentGamePlayer.name} 死了！${winner.name} 获胜！赢得${netWinnings}金币${repayment > 0 ? '（还款' + repayment + '）' : ''}`;
                            } else {
                                fireRoom.game.message = `💥 ${currentGamePlayer.name} 死了！同归于尽！`;
                            }
                        } else {
                            fireRoom.game.message = `💥 ${currentGamePlayer.name} 中弹身亡！`;
                            
                            do {
                                fireRoom.game.currentPlayerIndex = (fireRoom.game.currentPlayerIndex + 1) % fireRoom.players.length;
                            } while (!fireRoom.game.players[fireRoom.game.currentPlayerIndex].isAlive);
                            
                            const nextPlayer = fireRoom.game.players[fireRoom.game.currentPlayerIndex];
                            fireRoom.game.message += ` 轮到 ${nextPlayer.name}`;
                            
                            fireRoom.game.currentChamber = 0;
                            fireRoom.game.chambers = [false, false, false, false, false, false];
                            fireRoom.game.bulletPositions = [];
                            
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
                        fireRoom.game.history.push({
                            round: fireRoom.game.rounds,
                            player: currentGamePlayer.name,
                            result: 'survived',
                            chamber: fireRoom.game.currentChamber + 1
                        });
                        
                        fireRoom.game.currentChamber++;
                        
                        if (fireRoom.game.currentChamber >= 6) {
                            fireRoom.game.message = `🔘 ${currentGamePlayer.name} 奇迹般生还！重新装弹...`;
                            fireRoom.game.currentChamber = 0;
                            fireRoom.game.chambers = [false, false, false, false, false, false];
                            fireRoom.game.bulletPositions = [];
                            
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
                        
                        do {
                            fireRoom.game.currentPlayerIndex = (fireRoom.game.currentPlayerIndex + 1) % fireRoom.players.length;
                        } while (!fireRoom.game.players[fireRoom.game.currentPlayerIndex].isAlive);
                        
                        const nextPlayer = fireRoom.game.players[fireRoom.game.currentPlayerIndex];
                        fireRoom.game.message += ` 轮到 ${nextPlayer.name}`;
                    }
                    
                    broadcastRoom(currentRoom);
                    break;

                case 'nextGame':
                    if (!currentRoom || !currentPlayer) return;
                    const nextRoom = rooms.get(currentRoom);
                    if (!nextRoom) return;
                    
                    if (nextRoom.lastWinnerId && nextRoom.lastWinnerId !== currentPlayer) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '只有赢家可以开始下一局' }
                        }));
                        return;
                    }
                    
                    // 重置玩家投注
                    nextRoom.players.forEach(p => {
                        p.isHost = (p.id === currentPlayer);
                        p.isAlive = true;
                        p.isReady = false;
                        p.currentBet = 0;
                    });
                    
                    nextRoom.game = createGameState();
                    nextRoom.game.players = nextRoom.players;
                    nextRoom.game.phase = 'betting';
                    nextRoom.game.message = `${nextRoom.lastWinnerName || '赢家'}请投注，底注1金币`;
                    
                    broadcastRoom(currentRoom);
                    console.log(`房间 ${currentRoom} 开始下一局`);
                    break;

                case 'chat':
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
                const playerIndex = room.players.findIndex(p => p.id === currentPlayer);
                if (playerIndex > -1) {
                    const player = room.players[playerIndex];
                    room.players.splice(playerIndex, 1);
                    room.game.players = room.players;
                    
                    if (room.players.length === 0) {
                        rooms.delete(currentRoom);
                        console.log(`房间 ${currentRoom} 已删除`);
                    } else {
                        if (player.isHost && room.players.length > 0) {
                            room.players[0].isHost = true;
                        }
                        
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
