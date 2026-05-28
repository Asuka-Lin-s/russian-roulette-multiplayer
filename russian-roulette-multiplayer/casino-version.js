// 赌场版俄罗斯轮盘 - 核心逻辑

// 玩家数据（使用 localStorage 持久化）
const PlayerData = {
    coins: 200,
    debt: 0,
    lastWageTime: 0,
    
    // 特殊效果（持续一局）
    effects: {
        clown: false,  // 小丑面具
        alien: false   // 外星乱码
    },
    
    // 加载数据
    load() {
        const saved = localStorage.getItem('russianRouletteCasino');
        if (saved) {
            const data = JSON.parse(saved);
            this.coins = data.coins ?? 200;
            this.debt = data.debt ?? 0;
            this.lastWageTime = data.lastWageTime ?? 0;
        }
    },
    
    // 保存数据
    save() {
        localStorage.setItem('russianRouletteCasino', JSON.stringify({
            coins: this.coins,
            debt: this.debt,
            lastWageTime: this.lastWageTime
        }));
    },
    
    // 计算净资产
    getNetWorth() {
        return this.coins - this.debt * (13/9); // 债务按13/9计算实际负债
    },
    
    // 领取工资（24小时冷却）
    canClaimWage() {
        const now = Date.now();
        const cooldown = 24 * 60 * 60 * 1000; // 24小时
        return now - this.lastWageTime >= cooldown;
    },
    
    claimWage() {
        if (this.canClaimWage()) {
            this.coins += 200;
            this.lastWageTime = Date.now();
            this.save();
            return true;
        }
        return false;
    },
    
    // 借贷（9出13归）
    canTakeLoan() {
        return this.debt + 900 <= 10000;
    },
    
    takeLoan() {
        if (this.canTakeLoan()) {
            this.coins += 900;
            this.debt += 900;
            this.save();
            return true;
        }
        return false;
    },
    
    // 还款（从赢得的金币中扣除35%）
    repayFromWinnings(winnings) {
        if (this.debt > 0) {
            const repayment = Math.floor(winnings * 0.35);
            const actualRepayment = Math.min(repayment, this.debt * (13/9));
            this.debt = Math.max(0, this.debt - Math.floor(actualRepayment * (9/13)));
            return actualRepayment;
        }
        return 0;
    },
    
    // 检查是否破产
    isBroke() {
        return this.coins === 0 && this.debt >= 10000;
    },
    
    // 扣除投注
    placeBet(amount) {
        if (this.coins >= amount) {
            this.coins -= amount;
            this.save();
            return true;
        }
        return false;
    },
    
    // 赢得奖金
    winWinnings(amount) {
        const repayment = this.repayFromWinnings(amount);
        this.coins += (amount - repayment);
        this.save();
        return { total: amount, repayment };
    }
};

// 特殊子弹类型
const SpecialBullets = {
    NONE: 'none',
    CLOWN: 'clown',
    ALIEN: 'alien'
};

// 游戏状态
const GameState = {
    phase: 'idle', // idle, betting, playing, ended
    bulletCount: 1,
    betAmount: 10,
    pot: 0,
    chambers: [],
    bulletTypes: [], // 每个弹仓的子弹类型
    specialBullets: [], // 哪些位置有特殊子弹
    currentChamber: 0,
    currentTurn: 'player',
    round: 0,
    
    // 初始化游戏
    init(bulletCount, betAmount) {
        this.bulletCount = bulletCount;
        this.betAmount = betAmount;
        this.pot = betAmount * 2; // 玩家和电脑都投注
        this.currentChamber = 0;
        this.round = 1;
        this.phase = 'playing';
        this.currentTurn = 'player';
        
        // 生成弹仓
        this.chambers = [false, false, false, false, false, false];
        this.bulletTypes = Array(6).fill(SpecialBullets.NONE);
        this.specialBullets = [];
        
        // 随机位置
        const positions = [0, 1, 2, 3, 4, 5];
        for (let i = positions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [positions[i], positions[j]] = [positions[j], positions[i]];
        }
        
        // 填充普通子弹
        for (let i = 0; i < bulletCount; i++) {
            this.chambers[positions[i]] = true;
        }
        
        // 随机添加特殊子弹（最多2发特殊子弹）
        const specialCount = Math.min(2, bulletCount);
        const specialTypes = [SpecialBullets.CLOWN, SpecialBullets.ALIEN];
        
        for (let i = 0; i < specialCount; i++) {
            // 从有子弹的位置中随机选择
            const bulletPositions = positions.slice(0, bulletCount);
            const pos = bulletPositions[Math.floor(Math.random() * bulletPositions.length)];
            
            if (this.bulletTypes[pos] === SpecialBullets.NONE) {
                this.bulletTypes[pos] = specialTypes[i];
                this.specialBullets.push({ position: pos, type: specialTypes[i] });
            }
        }
        
        // 随机旋转转轮
        this.currentChamber = Math.floor(Math.random() * 6);
    },
    
    // 获取当前弹仓信息
    getCurrentChamberInfo() {
        return {
            hasBullet: this.chambers[this.currentChamber],
            bulletType: this.bulletTypes[this.currentChamber],
            position: this.currentChamber
        };
    },
    
    // 移动到下一弹仓
    nextChamber() {
        this.currentChamber++;
        return this.currentChamber < 6;
    },
    
    // 获取剩余子弹数
    getRemainingBullets() {
        let count = 0;
        for (let i = this.currentChamber; i < 6; i++) {
            if (this.chambers[i]) count++;
        }
        return count;
    }
};

// AI 逻辑
const AI = {
    // 决定是否接受投注
    acceptBet(betAmount) {
        // 电脑总是接受（简化版）
        return true;
    },
    
    // 决策开枪目标
    makeDecision() {
        const remainingChambers = 6 - GameState.currentChamber;
        const remainingBullets = GameState.getRemainingBullets();
        
        if (remainingChambers === 0) return 'self';
        
        const bulletProbability = remainingBullets / remainingChambers;
        
        // 考虑特殊子弹
        const currentInfo = GameState.getCurrentChamberInfo();
        if (currentInfo.hasBullet && currentInfo.bulletType !== SpecialBullets.NONE) {
            // 有特殊子弹，更倾向于对玩家开枪
            return Math.random() < 0.8 ? 'enemy' : 'self';
        }
        
        if (bulletProbability > 0.5) {
            return Math.random() < 0.7 ? 'enemy' : 'self';
        } else if (bulletProbability < 0.3) {
            return Math.random() < 0.7 ? 'self' : 'enemy';
        } else {
            return Math.random() < 0.5 ? 'self' : 'enemy';
        }
    }
};

// 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PlayerData, GameState, AI, SpecialBullets };
}
