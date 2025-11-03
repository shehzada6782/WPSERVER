// index.js (COMPLETE FIXED VERSION)
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
    isJidBroadcast
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 21129;

// ✅ FIX: Create ALL necessary directories
const directories = ["temp", "uploads", "public", "sessions"];
directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
    }
});

// ✅ FIX: Better multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    }
});

// ✅ FIX: Add CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public")));

// ✅ FIX: Serve static files with proper error handling
app.get("/", (req, res) => {
    const indexPath = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send(`
            <html>
                <body>
                    <h1>WhatsApp Bulk Sender</h1>
                    <p>Frontend files not found. Please check if public/index.html exists.</p>
                    <p>Server is running on port ${PORT}</p>
                </body>
            </html>
        `);
    }
});

// ✅ FIX: Health check endpoint
app.get("/api/health", (req, res) => {
    res.json({ 
        status: "OK", 
        timestamp: new Date().toISOString(),
        server: "WhatsApp Bulk Sender",
        version: "2.0"
    });
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

function getUserSession(userId) {
    if (!userId) {
        // Generate a random user ID if not provided
        userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            userId: userId,
            createdAt: new Date(),
            lastActive: new Date(),
            pairedNumbers: new Map()
        });
        console.log(`👤 New user session created: ${userId}`);
    }
    const userSession = userSessions.get(userId);
    userSession.lastActive = new Date();
    return userSession;
}

// ✅ FIX: Initialize user data endpoint
app.get("/api/init-user", (req, res) => {
    try {
        const userId = req.query.userId || ('user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
        const userSession = getUserSession(userId);
        
        res.json({
            success: true,
            userId: userId,
            message: "User initialized successfully",
            userData: {
                createdAt: userSession.createdAt,
                lastActive: userSession.lastActive
            }
        });
    } catch (error) {
        console.error("Error initializing user:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to initialize user data" 
        });
    }
});

// Cleanup inactive users (24 hours)
setInterval(() => {
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    userSessions.forEach((user, userId) => {
        if (user.lastActive < twentyFourHoursAgo) {
            console.log(`🧹 Cleaning up inactive user: ${userId}`);
            userSessions.delete(userId);
        }
    });
}, 60 * 60 * 1000);

// ✅ FIX: USER SESSIONS ENDPOINT WITH BETTER ERROR HANDLING
app.get("/api/user-sessions", (req, res) => {
    try {
        const userId = req.query.userId;
        
        if (!userId) {
            return res.status(400).json({ 
                success: false,
                error: "User ID is required" 
            });
        }

        const userSession = getUserSession(userId);
        const sessions = [...activeClients.entries()]
            .filter(([_, info]) => info.ownerId === userId)
            .map(([id, info]) => ({
                sessionId: id,
                number: info.number,
                registered: info.registered,
                pairingCode: info.pairingCode || "WAITING...",
                isConnecting: info.isConnecting || false,
                deviceInfo: info.deviceInfo || null,
                groups: info.groups || [],
                totalGroups: info.groups ? info.groups.length : 0
            }));

        res.json({
            success: true,
            userId: userId,
            sessions: sessions,
            total: sessions.length,
            userCreated: userSession.createdAt,
            lastActive: userSession.lastActive
        });
    } catch (error) {
        console.error("Error in user-sessions:", error);
        res.status(500).json({
            success: false,
            error: "Internal server error while loading user sessions"
        });
    }
});

// ✅ FIX: SIMPLIFIED PAIRING ENDPOINT
app.get("/api/pair", async (req, res) => {
    try {
        const num = req.query.number?.replace(/[^0-9]/g, "");
        const userId = req.query.userId;
        
        if (!num) {
            return res.status(400).json({ 
                success: false,
                error: "Invalid phone number" 
            });
        }
        
        if (!userId) {
            return res.status(400).json({ 
                success: false,
                error: "User ID is required" 
            });
        }

        console.log(`📱 Pairing request for: ${num}, User: ${userId}`);

        const sessionId = `session_${num}_${userId}`;
        const sessionPath = path.join("sessions", sessionId);

        // Create user session
        getUserSession(userId);

        // Create session directory
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        // Check if already registered
        if (state.creds?.registered) {
            console.log(`✅ Session already registered: ${sessionId}`);
            
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
                success: true,
                pairingCode: displayCode,
                sessionId: sessionId,
                status: "already-registered",
                message: "WhatsApp already paired and ready to use"
            });
        }

        // Create new session
        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: true,
            logger: pino({ level: "error" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
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
            deviceInfo: null
        };

        activeClients.set(sessionId, sessionInfo);

        let qrReceived = false;

        // Set timeout for QR code
        const qrTimeout = setTimeout(() => {
            if (!qrReceived) {
                console.log(`⏰ QR timeout for session: ${sessionId}`);
                if (activeClients.has(sessionId)) {
                    activeClients.delete(sessionId);
                }
                if (!res.headersSent) {
                    res.status(408).json({ 
                        success: false,
                        error: "QR code generation timeout. Please try again." 
                    });
                }
            }
        }, 30000);

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(`🔗 Connection update: ${connection} for ${sessionId}`);
            
            if (qr) {
                qrReceived = true;
                clearTimeout(qrTimeout);
                console.log(`📱 QR received for ${sessionId}`);
                
                res.json({
                    success: true,
                    pairingCode: displayCode,
                    qrCode: qr,
                    sessionId: sessionId,
                    status: "qr_received",
                    message: "Scan the QR code with WhatsApp"
                });
            }
            
            if (connection === "open") {
                clearTimeout(qrTimeout);
                console.log(`✅ WhatsApp connected: ${sessionId}`);
                
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.deviceInfo = {
                    platform: "WhatsApp Web",
                    pairedAt: new Date().toISOString(),
                    browser: "Chrome"
                };
                
                if (!res.headersSent) {
                    res.json({
                        success: true,
                        pairingCode: "CONNECTED",
                        sessionId: sessionId,
                        status: "connected",
                        message: "WhatsApp connected successfully!"
                    });
                }
            }
            
            if (connection === "close") {
                console.log(`❌ Connection closed: ${sessionId}`);
                if (!res.headersSent && !qrReceived) {
                    res.status(500).json({ 
                        success: false,
                        error: "Connection failed. Please try again." 
                    });
                }
            }
        });

        // Try to get pairing code directly
        setTimeout(async () => {
            if (!qrReceived && !res.headersSent) {
                try {
                    const pairingCode = await waClient.requestPairingCode(num);
                    if (pairingCode) {
                        qrReceived = true;
                        clearTimeout(qrTimeout);
                        sessionInfo.pairingCode = pairingCode;
                        
                        res.json({
                            success: true,
                            pairingCode: pairingCode,
                            sessionId: sessionId,
                            status: "code_received",
                            message: `Use pairing code: ${pairingCode}`
                        });
                    }
                } catch (error) {
                    console.log("Direct pairing not available yet:", error.message);
                }
            }
        }, 2000);

    } catch (error) {
        console.error("Pairing error:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to start pairing: " + error.message
        });
    }
});

// ✅ FIX: CHECK SESSION STATUS
app.get("/api/session-status", async (req, res) => {
    try {
        const { sessionId, userId } = req.query;
        
        if (!sessionId || !userId) {
            return res.status(400).json({ 
                success: false,
                error: "Session ID and User ID are required" 
            });
        }

        if (!activeClients.has(sessionId)) {
            return res.json({
                success: false,
                status: "not_found",
                message: "Session not found"
            });
        }

        const sessionInfo = activeClients.get(sessionId);
        
        if (sessionInfo.ownerId !== userId) {
            return res.status(403).json({ 
                success: false,
                error: "Access denied" 
            });
        }

        res.json({
            success: true,
            sessionId: sessionId,
            status: sessionInfo.registered ? "connected" : "connecting",
            registered: sessionInfo.registered,
            isConnecting: sessionInfo.isConnecting,
            pairingCode: sessionInfo.pairingCode,
            deviceInfo: sessionInfo.deviceInfo
        });

    } catch (error) {
        console.error("Session status error:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to check session status" 
        });
    }
});

// ✅ FIX: SIMPLIFIED SEND MESSAGE ENDPOINT
app.post("/api/send-message", upload.single("messageFile"), async (req, res) => {
    try {
        const { sessionId, target, targetType, delaySec, prefix, userId } = req.body;
        const filePath = req.file?.path;

        console.log(`📨 Send message request:`, { sessionId, target, targetType, delaySec, userId });

        // Validate inputs
        if (!sessionId || !target || !targetType || !delaySec || !userId || !filePath) {
            safeDeleteFile(filePath);
            return res.status(400).json({ 
                success: false,
                error: "All fields are required: sessionId, target, targetType, delaySec, userId, and message file" 
            });
        }

        if (!activeClients.has(sessionId)) {
            safeDeleteFile(filePath);
            return res.status(400).json({ 
                success: false,
                error: "Invalid session ID" 
            });
        }

        const sessionInfo = activeClients.get(sessionId);
        
        // Check ownership
        if (sessionInfo.ownerId !== userId) {
            safeDeleteFile(filePath);
            return res.status(403).json({ 
                success: false,
                error: "Access denied" 
            });
        }

        if (!sessionInfo.registered) {
            safeDeleteFile(filePath);
            return res.status(400).json({ 
                success: false,
                error: "Session not connected. Please pair first." 
            });
        }

        // Read messages from file
        let messages;
        try {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            messages = fileContent.split("\n")
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            if (messages.length === 0) {
                throw new Error("No messages found in file");
            }
        } catch (error) {
            safeDeleteFile(filePath);
            return res.status(400).json({ 
                success: false,
                error: "Invalid message file: " + error.message 
            });
        }

        const taskId = `TASK_${Date.now()}`;
        const taskInfo = {
            taskId,
            sessionId,
            ownerId: userId,
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

        // Send immediate response
        res.json({ 
            success: true,
            taskId: taskId,
            status: "started",
            totalMessages: messages.length,
            message: `Task started with ${messages.length} messages`
        });

        // Start sending messages in background
        processMessages(taskInfo, messages, sessionInfo, filePath);

    } catch (error) {
        console.error("Send message error:", error);
        safeDeleteFile(req.file?.path);
        res.status(500).json({ 
            success: false,
            error: "Failed to start message sending: " + error.message 
        });
    }
});

// ✅ FIX: MESSAGE PROCESSING FUNCTION
async function processMessages(taskInfo, messages, sessionInfo, filePath) {
    const { client: waClient } = sessionInfo;
    const delayMs = parseFloat(taskInfo.delaySec) * 1000;

    try {
        for (let i = 0; i < messages.length && !taskInfo.stopRequested; i++) {
            try {
                let message = messages[i];
                if (taskInfo.prefix) {
                    message = `${taskInfo.prefix} ${message}`;
                }

                const recipient = taskInfo.targetType === "group" 
                    ? (taskInfo.target.includes('@g.us') ? taskInfo.target : taskInfo.target + '@g.us')
                    : (taskInfo.target.includes('@s.whatsapp.net') ? taskInfo.target : taskInfo.target + '@s.whatsapp.net');

                await waClient.sendMessage(recipient, { text: message });
                
                taskInfo.sentMessages++;
                taskInfo.lastUpdate = new Date();

                // Progress update
                if (taskInfo.sentMessages % 10 === 0) {
                    console.log(`[${taskInfo.taskId}] Progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages}`);
                }

                // Delay between messages
                if (i < messages.length - 1 && !taskInfo.stopRequested) {
                    await delay(delayMs);
                }

            } catch (sendError) {
                console.error(`[${taskInfo.taskId}] Send error:`, sendError);
                // Continue with next message even if one fails
                taskInfo.sentMessages++;
            }
        }

    } catch (error) {
        console.error(`[${taskInfo.taskId}] Task error:`, error);
        taskInfo.error = error.message;
    } finally {
        taskInfo.isSending = false;
        taskInfo.endTime = new Date();
        safeDeleteFile(filePath);
        
        console.log(`[${taskInfo.taskId}] Completed: ${taskInfo.sentMessages}/${taskInfo.totalMessages} sent`);
    }
}

// ✅ FIX: STOP TASK ENDPOINT
app.post("/api/stop-task", (req, res) => {
    try {
        const { taskId, userId } = req.body;
        
        if (!taskId) {
            return res.status(400).json({ 
                success: false,
                error: "Task ID is required" 
            });
        }

        if (!activeTasks.has(taskId)) {
            return res.status(404).json({ 
                success: false,
                error: "Task not found" 
            });
        }

        const taskInfo = activeTasks.get(taskId);
        
        if (userId && taskInfo.ownerId !== userId) {
            return res.status(403).json({ 
                success: false,
                error: "Access denied" 
            });
        }

        taskInfo.stopRequested = true;
        taskInfo.isSending = false;

        res.json({
            success: true,
            message: `Task ${taskId} stopped successfully`,
            sentMessages: taskInfo.sentMessages,
            totalMessages: taskInfo.totalMessages
        });

    } catch (error) {
        console.error("Stop task error:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to stop task" 
        });
    }
});

// ✅ FIX: TASK STATUS ENDPOINT
app.get("/api/task-status", (req, res) => {
    try {
        const { taskId, userId } = req.query;
        
        if (!taskId) {
            return res.status(400).json({ 
                success: false,
                error: "Task ID is required" 
            });
        }

        if (!activeTasks.has(taskId)) {
            return res.json({
                success: false,
                status: "not_found"
            });
        }

        const taskInfo = activeTasks.get(taskId);
        
        if (userId && taskInfo.ownerId !== userId) {
            return res.status(403).json({ 
                success: false,
                error: "Access denied" 
            });
        }

        res.json({
            success: true,
            taskId: taskId,
            status: taskInfo.isSending ? "sending" : (taskInfo.stopRequested ? "stopped" : "completed"),
            sentMessages: taskInfo.sentMessages,
            totalMessages: taskInfo.totalMessages,
            progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100),
            startTime: taskInfo.startTime,
            endTime: taskInfo.endTime
        });

    } catch (error) {
        console.error("Task status error:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to get task status" 
        });
    }
});

// ✅ FIX: 404 handler for API routes
app.use("/api/*", (req, res) => {
    res.status(404).json({ 
        success: false,
        error: "API endpoint not found" 
    });
});

// ✅ FIX: Global error handler
app.use((error, req, res, next) => {
    console.error('Global Error Handler:', error);
    res.status(500).json({ 
        success: false,
        error: 'Internal Server Error: ' + error.message 
    });
});

// ✅ FIX: Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    activeClients.forEach((sessionInfo, sessionId) => {
        try {
            if (sessionInfo.client) {
                sessionInfo.client.end();
            }
        } catch (e) {
            console.error(`Error closing session ${sessionId}:`, e);
        }
    });
    
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp Bulk Sender FIXED Version Started!`);
    console.log(`📍 Server: http://localhost:${PORT}`);
    console.log(`✅ Health Check: http://localhost:${PORT}/api/health`);
    console.log(`👤 User Init: http://localhost:${PORT}/api/init-user`);
    console.log(`📱 Pairing: http://localhost:${PORT}/api/pair`);
    console.log(`\n⚡ Ready to use!`);
});
