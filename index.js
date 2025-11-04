// index.js (ERROR FIXED VERSION)
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 21129;

// Create necessary directories
if (!fs.existsSync("temp")) fs.mkdirSync("temp", { recursive: true });
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });
if (!fs.existsSync("public")) fs.mkdirSync("public", { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        // Generate unique filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + '.txt');
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/plain' || file.originalname.endsWith('.txt')) {
            cb(null, true);
        } else {
            cb(new Error('Only text files are allowed'), false);
        }
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- SESSION MANAGEMENT ---
const activeClients = new Map();
const activeTasks = new Map();

function safeDeleteFile(p) {
    try { 
        if (p && fs.existsSync(p)) {
            fs.unlinkSync(p); 
            console.log(`🗑️ Deleted file: ${p}`);
        }
    } catch (e) { 
        console.error(`Error deleting file ${p}:`, e);
    }
}

function generateDisplayCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// --- USER MANAGEMENT ---
const userSessions = new Map();

// Get or create user session
function getUserSession(userId) {
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            userId: userId,
            createdAt: new Date(),
            lastActive: new Date(),
            pairedNumbers: new Map()
        });
    }
    const userSession = userSessions.get(userId);
    userSession.lastActive = new Date();
    return userSession;
}

// Cleanup inactive users (24 hours)
setInterval(() => {
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    userSessions.forEach((user, userId) => {
        if (user.lastActive < twentyFourHoursAgo) {
            console.log(`🧹 Cleaning up inactive user: ${userId}`);
            userSessions.delete(userId);
        }
    });
}, 60 * 60 * 1000); // Run every hour

// --- FIXED PAIR NEW NUMBER ---
app.get("/code", async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, "");
    const userId = req.query.userId;
    
    if (!num) return res.status(400).json({ error: "Invalid number" });
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const sessionId = `session_${num}_${userId}`;
    const sessionPath = path.join("temp", sessionId);
    
    const existingSession = activeClients.get(sessionId);
    if (existingSession) {
        if (existingSession.isConnecting) {
            return res.status(400).json({ error: "Session is already being set up. Please wait." });
        }
        if (existingSession.registered) {
            return res.json({ 
                pairingCode: existingSession.pairingCode || "CONNECTED",
                waCode: "ALREADY_CONNECTED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered and ready to use",
                deviceInfo: existingSession.deviceInfo,
                groups: existingSession.groups || [],
                totalGroups: existingSession.groups ? existingSession.groups.length : 0
            });
        }
    }

    // Create user session if it doesn't exist
    getUserSession(userId);

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        if (state.creds?.registered) {
            const displayCode = generateDisplayCode();
            
            const sessionInfo = {
                client: null,
                number: num,
                authPath: sessionPath,
                registered: true,
                pairingCode: displayCode,
                ownerId: userId,
                isConnecting: false,
                deviceInfo: {
                    platform: "WhatsApp Web",
                    pairedAt: new Date().toISOString(),
                    browser: "Chrome"
                },
                pairedAt: new Date(),
                groups: [],
                groupsLastFetched: null
            };
            
            activeClients.set(sessionId, sessionInfo);
            
            return res.json({ 
                pairingCode: displayCode,
                waCode: "ALREADY_REGISTERED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered and ready to use",
                deviceInfo: sessionInfo.deviceInfo,
                groups: [],
                totalGroups: 0
            });
        }

        // ✅ FIXED: Simplified connection without complex QR parsing
        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: true,
            logger: pino({ level: "error" }), // Changed from silent to error for debugging
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            
            // ✅ FIXED: Better connection settings
            keepAliveIntervalMs: 10000,
            emitOwnEvents: false, // Changed to false to avoid conflicts
            retryRequestDelayMs: 1000,
            maxRetries: 5,
            fireInitQueries: false
        });

        const displayCode = generateDisplayCode();
        const sessionInfo = {
            client: waClient,
            number: num,
            authPath: sessionPath,
            registered: false,
            pairingCode: displayCode,
            ownerId: userId,
            isConnecting: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 3,
            deviceInfo: null,
            pairedAt: null,
            groups: [],
            groupsLastFetched: null
        };

        activeClients.set(sessionId, sessionInfo);

        let connectionTimeout;
        let isResolved = false;

        const resolveRequest = (data) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            sessionInfo.isConnecting = false;
            res.json(data);
        };

        const rejectRequest = (error) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            sessionInfo.isConnecting = false;
            res.status(500).json({ error });
        };

        connectionTimeout = setTimeout(() => {
            if (!isResolved) {
                console.log(`⏰ Connection timeout for ${sessionId}`);
                rejectRequest("Connection timeout. Please try again.");
            }
        }, 120000);

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(`🔗 Connection update: ${connection}`);
            
            if (connection === "open") {
                console.log(`✅ WhatsApp Connected for ${num}!`);
                
                try {
                    const user = waClient.user;
                    const deviceInfo = {
                        platform: user?.platform || "WhatsApp Web",
                        pairedAt: new Date().toISOString(),
                        browser: "Chrome",
                        phoneNumber: user?.id?.split(':')[0] || num,
                        deviceType: "Browser",
                        connection: "Active"
                    };
                    
                    sessionInfo.deviceInfo = deviceInfo;
                    sessionInfo.pairedAt = new Date();
                } catch (deviceErr) {
                    console.log("⚠️ Could not capture device info:", deviceErr);
                }
                
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
                
                if (!isResolved) {
                    resolveRequest({ 
                        pairingCode: "CONNECTED",
                        waCode: "CONNECTED",
                        sessionId: sessionId,
                        status: "connected",
                        message: "WhatsApp connected successfully!",
                        deviceInfo: sessionInfo.deviceInfo,
                        groups: [],
                        totalGroups: 0
                    });
                }
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Connection closed, status: ${statusCode}`);
                
                if (statusCode === 401) {
                    console.log(`🚫 Auth error for ${sessionId}`);
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                    if (!isResolved) {
                        rejectRequest("Authentication failed. Please pair again.");
                    }
                }
            }
            
            // ✅ FIXED: Simple QR handling without complex parsing
            if (qr && !isResolved) {
                console.log(`📱 QR code received`);
                
                resolveRequest({ 
                    pairingCode: displayCode,
                    waCode: qr,
                    sessionId: sessionId,
                    status: "qr_received", 
                    message: "Scan the QR code with WhatsApp"
                });
            }
        });

    } catch (err) {
        console.error("❌ Session creation error:", err);
        activeClients.delete(sessionId);
        return res.status(500).json({ error: "Server error: " + err.message });
    }
});

// --- SIMPLIFIED SEND MESSAGE ---
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { sessionId, target, targetType, delaySec, prefix, userId } = req.body;
    const filePath = req.file?.path;

    if (!sessionId || !activeClients.has(sessionId)) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid or inactive sessionId" });
    }
    
    const sessionInfo = activeClients.get(sessionId);
    
    if (userId && sessionInfo.ownerId !== userId) {
        safeDeleteFile(filePath);
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }
    
    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    if (!target || !filePath || !targetType || !delaySec) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Missing required fields" });
    }

    let messages;
    try {
        const fileContent = fs.readFileSync(filePath, "utf-8");
        messages = fileContent.split("\n")
            .map(m => m.trim())
            .filter(m => m.length > 0);
            
        if (messages.length === 0) throw new Error("Message file empty");
    } catch (err) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid message file: " + err.message });
    }

    const taskId = `TASK_${Date.now()}`;

    const taskInfo = {
        taskId,
        sessionId,
        ownerId: userId || sessionInfo.ownerId,
        isSending: true,
        stopRequested: false,
        totalMessages: messages.length,
        sentMessages: 0,
        target: target,
        targetType,
        prefix: prefix || "",
        startTime: new Date(),
        lastUpdate: new Date()
    };

    activeTasks.set(taskId, taskInfo);
    
    res.json({ 
        success: true,
        taskId: taskId,
        status: "started", 
        totalMessages: messages.length,
        message: `📨 Task STARTED! Use this ID to stop: ${taskId}`
    });

    console.log(`🚀 Task STARTED: ${taskId}`);
    console.log(`📝 Messages: ${messages.length}`);
    console.log(`🎯 Target: ${target}`);

    // Simplified task execution
    (async () => {
        try {
            for (let index = 0; index < messages.length && !taskInfo.stopRequested; index++) {
                try {
                    let msg = messages[index];
                    if (taskInfo.prefix) msg = `${taskInfo.prefix} ${msg}`;
                    
                    const recipient = taskInfo.targetType === "group"
                        ? (taskInfo.target.includes('@g.us') ? taskInfo.target : taskInfo.target + '@g.us')
                        : (taskInfo.target.includes('@s.whatsapp.net') ? taskInfo.target : taskInfo.target + '@s.whatsapp.net');

                    await sessionInfo.client.sendMessage(recipient, { text: msg });

                    taskInfo.sentMessages++;
                    taskInfo.lastUpdate = new Date();
                    
                    if (taskInfo.sentMessages % 10 === 0) {
                        console.log(`[${taskId}] Progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages}`);
                    }
                    
                } catch (sendErr) {
                    console.error(`[${taskId}] Send error:`, sendErr.message);
                    taskInfo.error = sendErr.message;
                    
                    if (sendErr.message?.includes("closed") || sendErr.message?.includes("disconnected")) {
                        taskInfo.stopRequested = true;
                        taskInfo.error = "Session disconnected.";
                    }
                }

                const waitMs = parseFloat(delaySec) * 1000;
                await delay(waitMs);
                
                if (taskInfo.stopRequested) break;
            }
        } finally {
            taskInfo.endTime = new Date();
            taskInfo.isSending = false;
            taskInfo.completed = !taskInfo.stopRequested;
            safeDeleteFile(filePath);
            
            const status = taskInfo.stopRequested ? "STOPPED" : "COMPLETED";
            console.log(`[${taskId}] ${status}: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);
            
            setTimeout(() => {
                if (activeTasks.has(taskId)) {
                    activeTasks.delete(taskId);
                }
            }, 600000);
        }
    })();
});

// --- SIMPLIFIED TASK STATUS ---
app.get("/task-status", (req, res) => {
    const taskId = req.query.taskId;
    const userId = req.query.userId;
    
    if (!taskId) return res.status(400).json({ error: "Task ID is required" });
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: "Task not found" });
    }

    const taskInfo = activeTasks.get(taskId);
    
    if (userId && taskInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
    }

    res.json({
        taskId: taskInfo.taskId,
        status: taskInfo.isSending ? "sending" : (taskInfo.stopRequested ? "stopped" : "completed"),
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages,
        progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100),
        startTime: taskInfo.startTime,
        endTime: taskInfo.endTime,
        error: taskInfo.error
    });
});

// --- STOP TASK ---
app.post("/stop-task", express.json(), async (req, res) => {
    const { taskId, userId } = req.body;
    
    if (!taskId) {
        return res.status(400).json({ error: "Task ID is required" });
    }
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: `Task ${taskId} not found` });
    }

    const taskInfo = activeTasks.get(taskId);
    
    if (userId && taskInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
    }
    
    taskInfo.stopRequested = true;
    taskInfo.isSending = false;
    taskInfo.endTime = new Date();

    console.log(`🛑 Task STOPPED: ${taskId}`);

    return res.json({ 
        success: true, 
        message: `Task ${taskId} stopped successfully`,
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages
    });
});

// --- USER SESSIONS ---
app.get("/user-sessions", (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    const userSession = getUserSession(userId);
    const sessions = [...activeClients.entries()]
        .filter(([_, info]) => info.ownerId === userId)
        .map(([id, info]) => ({
            sessionId: id,
            number: info.number,
            registered: info.registered,
            pairingCode: info.pairingCode || "WAITING...",
            isConnecting: info.isConnecting || false
        }));

    res.json({
        userId: userId,
        sessions: sessions,
        total: sessions.length
    });
});

// --- USER TASKS ---
app.get("/user-tasks", (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const userTasks = [...activeTasks.entries()]
        .filter(([_, task]) => task.ownerId === userId)
        .map(([id, task]) => ({
            taskId: id,
            sessionId: task.sessionId,
            isSending: task.isSending,
            sentMessages: task.sentMessages,
            totalMessages: task.totalMessages,
            startTime: task.startTime,
            progress: Math.round((task.sentMessages / task.totalMessages) * 100)
        }));
    
    res.json({ 
        tasks: userTasks,
        total: userTasks.length
    });
});

// --- DELETE SESSION ---
app.post("/delete-session", express.json(), async (req, res) => {
    const { sessionId, userId } = req.body;
    
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    if (!userId) return res.status(400).json({ error: "User ID is required" });
    
    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    if (sessionInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
    }

    try {
        if (sessionInfo.client) {
            sessionInfo.client.end();
        }
        
        if (sessionInfo.authPath && fs.existsSync(sessionInfo.authPath)) {
            fs.rmSync(sessionInfo.authPath, { recursive: true, force: true });
        }
        
        activeClients.delete(sessionId);
        
        res.json({ 
            success: true, 
            message: `Session ${sessionId} deleted successfully` 
        });
        
    } catch (err) {
        console.error(`❌ Error deleting session ${sessionId}:`, err);
        res.status(500).json({ error: "Failed to delete session" });
    }
});

// --- HEALTH CHECK ---
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        stats: {
            totalUsers: userSessions.size,
            totalSessions: activeClients.size,
            totalTasks: activeTasks.size
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server Error:', error);
    res.status(500).json({ 
        error: 'Internal Server Error',
        message: error.message
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    activeClients.forEach(({ client }, sessionId) => {
        try { 
            if (client) {
                client.end(); 
            }
        } catch (e) { 
            console.error(`Error closing session ${sessionId}:`, e);
        }
    });
    
    console.log('✅ Server shutdown complete');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp Bulk Server Started!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`✅ Fixed version - String pattern error resolved`);
});
