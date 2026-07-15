const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(__dirname));

// ==================== CONFIGURATION ====================
// Nolimit City integration — update these when you get operator credentials
const NOLIMIT = {
    operatorId: 'SMOOTHOPERATOR',
    tokenSecret: 'change-this-to-a-strong-random-secret-at-least-32-chars',
    tokenExpirySeconds: 8 * 60 * 60  // 8 hours
};

// ==================== DATABASE ====================
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'OnlineCasino',
    waitForConnections: true,
    connectionLimit: 10
});

// ==================== S2S AUTH MIDDLEWARE ====================
/**
 * Verifies the JWT token from Nolimit's game server on S2S calls.
 * The game server passes the token (originally issued by /api/nolimit/token)
 * back to the operator to authenticate server-to-server requests.
 */
function authenticateS2S(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        let tokenStr = null;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            tokenStr = authHeader.slice(7);
        } else if (req.body && req.body.token) {
            tokenStr = req.body.token;
        } else if (req.query && req.query.token) {
            tokenStr = req.query.token;
        }

        if (!tokenStr) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(tokenStr, NOLIMIT.tokenSecret, { algorithms: ['HS256'] });
        req.tokenPayload = decoded;
        next();
    } catch (err) {
        console.error('S2S auth failed:', err.message);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ==================== NOLIMIT CITY ROUTES ====================

/**
 * POST /api/nolimit/token
 * Generates a JWT token for launching a Nolimit game.
 * The token identifies the player and is passed to nolimit.load({ token }).
 */
app.post('/api/nolimit/token', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }
    try {
        const [[user]] = await pool.query(
            'SELECT UserID, Username FROM Users WHERE UserID = ?', [userId]
        );
        if (!user) return res.status(404).json({ error: 'User not found' });

        const [[wallet]] = await pool.query(
            'SELECT Currency FROM Wallets WHERE UserID = ?', [userId]
        );
        const currency = wallet?.Currency || 'USD';

        const payload = {
            userId: user.UserID,
            username: user.Username,
            currency: currency,
            operatorId: NOLIMIT.operatorId,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + NOLIMIT.tokenExpirySeconds
        };

        const token = jwt.sign(payload, NOLIMIT.tokenSecret, { algorithm: 'HS256' });
        res.json({ token, operatorId: NOLIMIT.operatorId });
    } catch (err) {
        console.error('Token generation error:', err);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

/**
 * POST /api/nolimit/s2s/player
 * Called by Nolimit's server to get player balance and info.
 */
app.post('/api/nolimit/s2s/player', authenticateS2S, async (req, res) => {
    const { userId } = req.tokenPayload;
    try {
        const [[wallet]] = await pool.query(
            'SELECT Balance, BonusBalance, Currency FROM Wallets WHERE UserID = ?', [userId]
        );
        const [[user]] = await pool.query(
            'SELECT Username FROM Users WHERE UserID = ?', [userId]
        );
        res.json({
            userId: userId,
            username: user?.Username || '',
            balance: wallet?.Balance || 0,
            bonusBalance: wallet?.BonusBalance || 0,
            currency: wallet?.Currency || 'USD'
        });
    } catch (err) {
        console.error('S2S player error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/nolimit/s2s/bet
 * Called by Nolimit's server when the player places a bet.
 */
app.post('/api/nolimit/s2s/bet', authenticateS2S, async (req, res) => {
    const { userId } = req.tokenPayload;
    const { gameId, amount, roundReference, transactionId } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [[wallet]] = await connection.query(
            'SELECT Balance FROM Wallets WHERE UserID = ? FOR UPDATE', [userId]
        );
        if (!wallet || wallet.Balance < amount) {
            await connection.rollback();
            return res.status(402).json({ error: 'Insufficient balance' });
        }

        await connection.query(
            'UPDATE Wallets SET Balance = Balance - ? WHERE UserID = ?', [amount, userId]
        );

        const nolimitGameId = gameId || 'nolimit';
        const [[gameRow]] = await connection.query(
            'SELECT GameID FROM Games WHERE GameProvider = ? AND GameName = ?',
            ['Nolimit City', nolimitGameId]
        );
        const dbGameId = gameRow?.GameID || 1;

        const [result] = await connection.query(
            'INSERT INTO Bets (UserID, GameID, BetAmount, RoundReference) VALUES (?, ?, ?, ?)',
            [userId, dbGameId, amount, roundReference || transactionId || 'NOLIMIT']
        );

        await connection.commit();

        const [[newWallet]] = await pool.query(
            'SELECT Balance, BonusBalance, Currency FROM Wallets WHERE UserID = ?', [userId]
        );
        res.json({
            success: true,
            betId: result.insertId,
            transactionId: transactionId || 'BET-' + result.insertId,
            balance: newWallet.Balance,
            bonusBalance: newWallet.BonusBalance,
            currency: newWallet.Currency || 'USD'
        });
    } catch (err) {
        await connection.rollback();
        console.error('S2S bet error:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        connection.release();
    }
});

/**
 * POST /api/nolimit/s2s/win
 * Called by Nolimit's server when the player wins.
 */
app.post('/api/nolimit/s2s/win', authenticateS2S, async (req, res) => {
    const { userId } = req.tokenPayload;
    const { betId, amount, transactionId } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        await connection.query(
            'UPDATE Wallets SET Balance = Balance + ? WHERE UserID = ?', [amount, userId]
        );

        if (betId) {
            await connection.query(
                'UPDATE Bets SET WinAmount = COALESCE(WinAmount, 0) + ?, IsProcessed = 1 WHERE BetID = ?',
                [amount, betId]
            );
        }

        await connection.commit();

        const [[newWallet]] = await pool.query(
            'SELECT Balance, BonusBalance, Currency FROM Wallets WHERE UserID = ?', [userId]
        );
        res.json({
            success: true,
            transactionId: transactionId || 'WIN-' + Date.now(),
            balance: newWallet.Balance,
            bonusBalance: newWallet.BonusBalance,
            currency: newWallet.Currency || 'USD'
        });
    } catch (err) {
        await connection.rollback();
        console.error('S2S win error:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        connection.release();
    }
});

/**
 * POST /api/nolimit/s2s/refund
 * Called by Nolimit's server to refund a previous bet.
 */
app.post('/api/nolimit/s2s/refund', authenticateS2S, async (req, res) => {
    const { userId } = req.tokenPayload;
    const { betId, amount, transactionId } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        await connection.query(
            'UPDATE Wallets SET Balance = Balance + ? WHERE UserID = ?', [amount, userId]
        );

        if (betId) {
            await connection.query(
                'UPDATE Bets SET WinAmount = COALESCE(WinAmount, 0) + ?, IsProcessed = 1 WHERE BetID = ?',
                [amount, betId]
            );
        }

        await connection.commit();

        const [[newWallet]] = await pool.query(
            'SELECT Balance, BonusBalance, Currency FROM Wallets WHERE UserID = ?', [userId]
        );
        res.json({
            success: true,
            transactionId: transactionId || 'REFUND-' + Date.now(),
            balance: newWallet.Balance,
            bonusBalance: newWallet.BonusBalance,
            currency: newWallet.Currency || 'USD'
        });
    } catch (err) {
        await connection.rollback();
        console.error('S2S refund error:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        connection.release();
    }
});

// ==================== EXISTING CASINO ROUTES ====================

// ---------- Login ----------
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query(
            'SELECT UserID, Username, PasswordHash FROM Users WHERE Username = ?',
            [username]
        );
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const match = await bcrypt.compare(password, rows[0].PasswordHash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({ userId: rows[0].UserID, username: rows[0].Username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Register ----------
app.post('/api/register', async (req, res) => {
    const { username, password, email, dob } = req.body;
    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO Users (Username, PasswordHash, Email, DateOfBirth) VALUES (?, ?, ?, ?)',
            [username, hashed, email, dob]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message });
    }
});

// ---------- Get Balance ----------
app.get('/api/balance/:userId', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT Balance, BonusBalance FROM Wallets WHERE UserID = ?',
            [req.params.userId]
        );
        if (rows.length === 0) {
            return res.json({ balance: 0, bonusBalance: 0 });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- List Games ----------
app.get('/api/games', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT GameID, GameName, GameType, GameProvider, MinBet, MaxBet, RTP FROM Games WHERE IsActive = 1'
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Place a Bet ----------
app.post('/api/placeBet', async (req, res) => {
    const { userId, gameId, amount } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [[wallet]] = await connection.query(
            'SELECT Balance FROM Wallets WHERE UserID = ? FOR UPDATE',
            [userId]
        );
        if (!wallet || wallet.Balance < amount) {
            throw new Error('Insufficient balance');
        }
        await connection.query(
            'UPDATE Wallets SET Balance = Balance - ? WHERE UserID = ?',
            [amount, userId]
        );
        const [result] = await connection.query(
            'INSERT INTO Bets (UserID, GameID, BetAmount, RoundReference) VALUES (?, ?, ?, UUID())',
            [userId, gameId, amount]
        );
        await connection.commit();
        res.json({ success: true, betId: result.insertId, roundReference: 'uuid_generated' });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// ---------- Process a Win ----------
app.post('/api/processWin', async (req, res) => {
    const { betId, winAmount } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [[bet]] = await connection.query(
            'SELECT UserID FROM Bets WHERE BetID = ?',
            [betId]
        );
        if (!bet) throw new Error('Bet not found');
        await connection.query(
            'UPDATE Bets SET WinAmount = ?, IsProcessed = 1 WHERE BetID = ?',
            [winAmount, betId]
        );
        await connection.query(
            'UPDATE Wallets SET Balance = Balance + ? WHERE UserID = ?',
            [winAmount, bet.UserID]
        );
        await connection.commit();
        res.json({ success: true });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// ---------- Recent Bets ----------
app.get('/api/bets/:userId', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT b.BetID, b.BetAmount, b.WinAmount, b.BetTimestamp, g.GameName
             FROM Bets b
             JOIN Games g ON b.GameID = g.GameID
             WHERE b.UserID = ?
             ORDER BY b.BetTimestamp DESC
             LIMIT 20`,
            [req.params.userId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== MAME SESSION TRACKING ====================

// In-memory session store for active MAME sessions
const mameSessions = {};

/**
 * POST /api/mame/session_start
 * Called by the MAME Lua plugin when the game starts.
 */
app.post('/api/mame/session_start', (req, res) => {
    const { userId, rom } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const sessionId = 'mame_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    mameSessions[sessionId] = {
        userId: parseInt(userId),
        rom: rom || 'unknown',
        startedAt: new Date().toISOString(),
        coinInsertions: 0,
        totalBet: 0,
        totalWin: 0
    };
    console.log(`MAME session started: ${sessionId} (user ${userId}, rom ${rom})`);
    res.json({ sessionId, success: true });
});

/**
 * POST /api/mame/coin
 * Called when the player inserts coins in MAME.
 */
app.post('/api/mame/coin', async (req, res) => {
    const { userId, rom, coins } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const coinCount = coins || 1;
    // In Cherry Master, each coin = 1 credit = base bet
    const betAmount = coinCount * 0.25; // Base stake per coin

    try {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const [[wallet]] = await connection.query(
                'SELECT Balance FROM Wallets WHERE UserID = ? FOR UPDATE', [userId]
            );
            if (!wallet || wallet.Balance < betAmount) {
                await connection.rollback();
                return res.status(402).json({ error: 'Insufficient balance' });
            }
            await connection.query(
                'UPDATE Wallets SET Balance = Balance - ? WHERE UserID = ?', [betAmount, userId]
            );

            // Find or use MAME game ID
            const [[gameRow]] = await connection.query(
                'SELECT GameID FROM Games WHERE GameProvider = ? AND GameName = ?',
                ['MAME', rom || 'cmtetris']
            );
            const dbGameId = gameRow?.GameID || 2;

            const [result] = await connection.query(
                'INSERT INTO Bets (UserID, GameID, BetAmount, RoundReference) VALUES (?, ?, ?, ?)',
                [userId, dbGameId, betAmount, 'MAME_COIN_' + Date.now()]
            );
            await connection.commit();

            const [[newWallet]] = await pool.query(
                'SELECT Balance FROM Wallets WHERE UserID = ?', [userId]
            );

            // Update session tracking
            for (const [sid, sess] of Object.entries(mameSessions)) {
                if (sess.userId === parseInt(userId)) {
                    sess.coinInsertions += coinCount;
                    sess.totalBet += betAmount;
                }
            }

            res.json({
                success: true,
                betId: result.insertId,
                amount: betAmount,
                balance: newWallet.Balance
            });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        console.error('MAME coin error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/mame/session_end
 * Called when MAME exits. Syncs final state.
 */
app.post('/api/mame/session_end', async (req, res) => {
    const { userId, rom, creditsRemaining } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Find and clean up session
    let sessionData = null;
    for (const [sid, sess] of Object.entries(mameSessions)) {
        if (sess.userId === parseInt(userId)) {
            sessionData = sess;
            delete mameSessions[sid];
            break;
        }
    }

    console.log(`MAME session ended: user ${userId}, rom ${rom || 'unknown'}`,
        sessionData ? `bets: $${sessionData.totalBet}` : '');

    // Refresh the balance from DB
    try {
        const [[wallet]] = await pool.query(
            'SELECT Balance FROM Wallets WHERE UserID = ?', [userId]
        );
        res.json({
            success: true,
            balance: wallet?.Balance || 0,
            session: sessionData
        });
    } catch (err) {
        res.json({ success: true, session: sessionData });
    }
});

/**
 * GET /api/mame/status
 * Returns current balance for the MAME launcher page to poll.
 */
app.get('/api/mame/status/:userId', async (req, res) => {
    try {
        const [[wallet]] = await pool.query(
            'SELECT Balance, BonusBalance FROM Wallets WHERE UserID = ?', [req.params.userId]
        );
        // Check if there's an active MAME session
        let activeSession = null;
        for (const [sid, sess] of Object.entries(mameSessions)) {
            if (sess.userId === parseInt(req.params.userId)) {
                activeSession = { sessionId: sid, rom: sess.rom, startedAt: sess.startedAt };
                break;
            }
        }
        res.json({
            balance: wallet?.Balance || 0,
            bonusBalance: wallet?.BonusBalance || 0,
            activeSession: activeSession
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== MAME LAUNCHER ====================

/**
 * POST /api/mame/launch
 * Launches MAME with the specified ROM as a detached process.
 * ROMs are loaded from ~/Downloads/ROMS and MAME config is in ~/cfg.
 */
app.post('/api/mame/launch', (req, res) => {
    const { rom, userId } = req.body;
    if (!rom) {
        return res.status(400).json({ error: 'ROM name is required' });
    }

    // Whitelist known Cherry Master ROMs
    const allowedRoms = ['cmtetris', 'cherry96', 'chry10', 'pacslot'];
    if (!allowedRoms.includes(rom)) {
        return res.status(400).json({ error: 'Unknown ROM: ' + rom });
    }

    try {
        const { spawn } = require('child_process');
        const homeDir = require('os').homedir();
        const romPath = `${homeDir}\\Downloads\\ROMS`;
        const cfgPath = `${homeDir}\\cfg`;
        const nvramPath = `${homeDir}\\nvram`;
        const pluginPath = `${homeDir}\\.mame\\plugins`;

        // MAME command: launch in a window with casino sync plugin
        const mameArgs = [
            rom,
            '-rompath', romPath,
            '-cfg_directory', cfgPath,
            '-nvram_directory', nvramPath,
            '-pluginspath', pluginPath,
            '-plugins',
            '-plugin', 'casino_sync',
            '-window',
            '-nomouse',
            '-skip_gameinfo',
            '-nowaitvsync'
        ];

        // Pass userId to the plugin via pluginsparam
        if (userId) {
            mameArgs.push('-pluginsparam', `userid=${userId}`);
        }

        const mame = spawn('mame', mameArgs, {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            env: {
                ...process.env,
                CASINO_USER_ID: userId ? String(userId) : ''
            }
        });

        mame.unref();

        console.log(`MAME launched: ${rom} (PID: ${mame.pid}, user: ${userId || 'none'})`);
        res.json({
            success: true,
            rom: rom,
            userId: userId || null,
            pid: mame.pid,
            message: `MAME launched with ${rom}. Balance syncing enabled.`
        });
    } catch (err) {
        console.error('MAME launch error:', err);
        res.status(500).json({ error: 'Failed to launch MAME: ' + err.message });
    }
});

// ==================== PROGRESSIVE JACKPOT ====================

// In-memory progressive jackpot (survives server restarts by seeding from DB)
let progressiveJackpot = 1000;

// Seed jackpot from DB on startup
(async () => {
    try {
        const [[row]] = await pool.query("SELECT Value FROM Settings WHERE `Key` = 'jackpot'");
        if (row) progressiveJackpot = parseFloat(row.Value) || 1000;
    } catch(e) { /* table might not exist yet */ }
})();

app.get('/api/jackpot', (req, res) => {
    res.json({ jackpot: Math.round(progressiveJackpot * 100) / 100 });
});

app.post('/api/jackpot', async (req, res) => {
    const { jackpot } = req.body;
    if (typeof jackpot === 'number') {
        progressiveJackpot = jackpot;
        try {
            await pool.query("INSERT INTO Settings (`Key`, Value) VALUES ('jackpot', ?) ON DUPLICATE KEY UPDATE Value = ?", [jackpot, jackpot]);
        } catch(e) {}
    }
    res.json({ jackpot: progressiveJackpot });
});

// ==================== LEADERBOARD ====================

app.get('/api/leaderboard', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT u.Username, SUM(b.WinAmount) as totalWon, COUNT(b.BetID) as totalBets
             FROM Bets b JOIN Users u ON b.UserID = u.UserID
             WHERE b.WinAmount > 0
             GROUP BY b.UserID ORDER BY totalWon DESC LIMIT 10`
        );
        res.json(rows);
    } catch(e) {
        res.json([]);
    }
});

// ==================== DAILY BONUS ====================

app.post('/api/daily-bonus', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        // Check if already claimed today
        const today = new Date().toISOString().slice(0, 10);
        const [[claim]] = await pool.query(
            "SELECT ClaimID FROM DailyClaims WHERE UserID = ? AND ClaimDate = ?", [userId, today]
        );
        if (claim) return res.json({ claimed: true, amount: 0, message: 'Already claimed today' });

        // Calculate bonus (streak-based)
        const [[streak]] = await pool.query(
            "SELECT ClaimDate FROM DailyClaims WHERE UserID = ? ORDER BY ClaimDate DESC LIMIT 1", [userId]
        );
        let bonusStreak = 1;
        if (streak) {
            const lastDate = new Date(streak.ClaimDate);
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            if (lastDate.toISOString().slice(0, 10) === yesterday.toISOString().slice(0, 10)) {
                bonusStreak = Math.min(7, ((await pool.query("SELECT COUNT(*) as cnt FROM DailyClaims WHERE UserID = ?", [userId]))[0][0]?.cnt || 1) + 1);
            }
        }
        const amounts = [1, 1.5, 2, 3, 5, 8, 10];
        const amount = amounts[Math.min(bonusStreak - 1, 6)];

        // Credit the bonus
        await pool.query("INSERT INTO DailyClaims (UserID, ClaimDate, Amount, Streak) VALUES (?, ?, ?, ?)", [userId, today, amount, bonusStreak]);
        await pool.query("UPDATE Wallets SET Balance = Balance + ? WHERE UserID = ?", [amount, userId]);

        const [[wallet]] = await pool.query("SELECT Balance FROM Wallets WHERE UserID = ?", [userId]);
        res.json({ claimed: false, amount, streak: bonusStreak, balance: wallet.Balance, message: `Day ${bonusStreak} bonus! +$${amount.toFixed(2)}` });
    } catch(e) {
        console.error('Daily bonus error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ==================== VOUCHER CODES ====================

app.post('/api/voucher/redeem', async (req, res) => {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });

    try {
        const [[voucher]] = await pool.query(
            "SELECT * FROM Vouchers WHERE Code = ? AND IsUsed = 0 AND (ExpiresAt IS NULL OR ExpiresAt > NOW())", [code]
        );
        if (!voucher) return res.status(404).json({ error: 'Invalid or expired voucher' });

        await pool.query("UPDATE Vouchers SET IsUsed = 1, UsedBy = ?, UsedAt = NOW() WHERE VoucherID = ?", [userId, voucher.VoucherID]);
        await pool.query("UPDATE Wallets SET Balance = Balance + ? WHERE UserID = ?", [voucher.Amount, userId]);

        const [[wallet]] = await pool.query("SELECT Balance FROM Wallets WHERE UserID = ?", [userId]);
        res.json({ success: true, amount: voucher.Amount, balance: wallet.Balance, message: `Voucher redeemed! +$${voucher.Amount.toFixed(2)}` });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: create voucher
app.post('/api/admin/create-voucher', async (req, res) => {
    const { code, amount, expiresAt } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'code and amount required' });
    try {
        await pool.query("INSERT INTO Vouchers (Code, Amount, ExpiresAt) VALUES (?, ?, ?)", [code.toUpperCase(), amount, expiresAt || null]);
        res.json({ success: true, code: code.toUpperCase(), amount });
    } catch(e) {
        res.status(400).json({ error: e.message });
    }
});

// ==================== PLAYER STATS ====================

app.get('/api/stats/:userId', async (req, res) => {
    try {
        const [[totals]] = await pool.query(
            "SELECT COUNT(*) as totalSpins, COALESCE(SUM(BetAmount),0) as totalBet, COALESCE(SUM(WinAmount),0) as totalWin FROM Bets WHERE UserID = ?", [req.params.userId]
        );
        const today = new Date().toISOString().slice(0, 10);
        const [[todayStats]] = await pool.query(
            "SELECT COALESCE(SUM(WinAmount),0) as todayWin FROM Bets WHERE UserID = ? AND DATE(BetTimestamp) = ?", [req.params.userId, today]
        );
        const [[dailyClaim]] = await pool.query(
            "SELECT ClaimID FROM DailyClaims WHERE UserID = ? AND ClaimDate = ?", [req.params.userId, today]
        );
        res.json({
            totalSpins: totals.totalSpins,
            totalBet: totals.totalBet,
            totalWin: totals.totalWin,
            rtp: totals.totalBet > 0 ? (totals.totalWin / totals.totalBet * 100).toFixed(1) : 0,
            todayWin: todayStats.todayWin,
            dailyClaimed: !!dailyClaim
        });
    } catch(e) {
        res.json({ totalSpins: 0, totalBet: 0, totalWin: 0, rtp: 0, todayWin: 0, dailyClaimed: false });
    }
});

// ==================== ADMIN ====================

/**
 * POST /api/admin/add-balance
 * Manually add balance to a user's wallet. Creates wallet if it doesn't exist.
 */
app.post('/api/admin/add-balance', async (req, res) => {
    const { username, userId, amount, type } = req.body;
    const addAmount = parseFloat(amount);

    if (!addAmount || addAmount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const balanceType = type === 'bonus' ? 'BonusBalance' : 'Balance';

    try {
        let targetUserId = userId;

        // Look up by username if no userId provided
        if (!targetUserId && username) {
            const [[user]] = await pool.query(
                'SELECT UserID FROM Users WHERE Username = ?', [username]
            );
            if (!user) return res.status(404).json({ error: 'User not found: ' + username });
            targetUserId = user.UserID;
        }

        if (!targetUserId) {
            return res.status(400).json({ error: 'username or userId is required' });
        }

        // Ensure wallet exists
        const [[wallet]] = await pool.query(
            'SELECT WalletID FROM Wallets WHERE UserID = ?', [targetUserId]
        );
        if (!wallet) {
            await pool.query(
                'INSERT INTO Wallets (UserID, Balance, BonusBalance, Currency) VALUES (?, 0, 0, ?)',
                [targetUserId, 'USD']
            );
        }

        // Add the balance
        await pool.query(
            `UPDATE Wallets SET ${balanceType} = ${balanceType} + ? WHERE UserID = ?`,
            [addAmount, targetUserId]
        );

        // Get updated balance
        const [[updated]] = await pool.query(
            'SELECT Balance, BonusBalance FROM Wallets WHERE UserID = ?', [targetUserId]
        );

        console.log(`Admin: +$${addAmount.toFixed(2)} to user ${targetUserId} (${balanceType})`);

        res.json({
            success: true,
            userId: targetUserId,
            added: addAmount,
            type: balanceType,
            balance: updated.Balance,
            bonusBalance: updated.BonusBalance
        });
    } catch (err) {
        console.error('Admin add-balance error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Lobby:    http://localhost:${PORT}/lobby.html`);
    console.log(`Slot:     http://localhost:${PORT}/index.html`);
});
