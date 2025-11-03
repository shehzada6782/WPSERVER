// index.js (Fixed Version - No Auto Stop)
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

// Create necessary directories
if (!fs.existsSync("temp")) fs.mkdirSync("temp", { recursive: true });
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });
if (!fs.existsSync("public")) fs.mkdirSync("public", { recursive: true });

// Configure multer for file uploads
const upload = multer({ 
    dest: "uploads/",
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
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
}, 60 * 60 * 1000);

// --- IMPROVED SESSION RECONNECTION LOGIC ---
async function ensureSessionConnected(sessionInfo, sessionId) {
    if (!sessionInfo.client || !sessionInfo.registered) {
        console.log(`🔄 Reinitializing disconnected session: ${sessionId}`);
        await initializeClient(sessionId, sessionInfo);
        
        // Wait for connection
        let attempts = 0;
        while (attempts < 30 && (!sessionInfo.registered || sessionInfo.isConnecting)) {
            await delay(2000);
            attempts++;
        }
        
        if (sessionInfo.registered && !sessionInfo.isConnecting) {
            console.log(`✅ Session reconnected: ${sessionId}`);
            return true;
        } else {
            console.log(`❌ Failed to reconnect session: ${sessionId}`);
            return false;
        }
    }
    return true;
}

// --- IMPROVED SEND MESSAGE WITH AUTO-RECONNECT ---
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { sessionId, target, targetType, delaySec, prefix, userId, groupId } = req.body;
    const filePath = req.file?.path;

    if (!sessionId || !activeClients.has(sessionId)) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid or inactive sessionId" });
    }
    
    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK IF SESSION BELONGS TO THE USER
    if (userId && sessionInfo.ownerId !== userId) {
        safeDeleteFile(filePath);
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }
    
    // ENSURE SESSION IS CONNECTED BEFORE STARTING
    if (!await ensureSessionConnected(sessionInfo, sessionId)) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Session not connected. Please reconnect and try again." });
    }

    if ((!target && !groupId) || !filePath || !targetType || !delaySec) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Missing required fields" });
    }

    let { client: waClient } = sessionInfo;
    
    // Use groupId if provided, otherwise use target
    let finalTarget = target;
    if (groupId && targetType === "group") {
        finalTarget = groupId;
    }
    
    if (!finalTarget) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "No target specified" });
    }

    const taskId = `TASK_${Date.now()}`;

    let messages;
    try {
        messages = fs.readFileSync(filePath, "utf-8").split("\n").map(m => m.trim()).filter(Boolean);
        if (messages.length === 0) throw new Error("Message file empty");
    } catch (err) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid message file" });
    }

    const taskInfo = {
        taskId,
        sessionId,
        ownerId: userId || sessionInfo.ownerId,
        isSending: true,
        stopRequested: false,
        totalMessages: messages.length,
        sentMessages: 0,
        target: finalTarget,
        targetType,
        prefix: prefix || "",
        startTime: new Date(),
        lastUpdate: new Date(),
        groupId: groupId || null,
        reconnectAttempts: 0,
        maxReconnectAttempts: 10, // Increased reconnection attempts
        lastReconnect: null
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
    console.log(`🎯 Target: ${finalTarget}`);
    console.log(`🛑 STOP COMMAND: Use taskId: ${taskId}`);

    // IMPROVED TASK EXECUTION WITH AUTO-RECONNECT
    (async () => {
        try {
            for (let index = 0; index < messages.length && !taskInfo.stopRequested; index++) {
                let messageSent = false;
                let sendAttempts = 0;
                const maxSendAttempts = 3;

                while (!messageSent && sendAttempts < maxSendAttempts && !taskInfo.stopRequested) {
                    try {
                        // CHECK AND RECONNECT SESSION IF NEEDED
                        if (!sessionInfo.client || !sessionInfo.registered || sessionInfo.isConnecting) {
                            console.log(`🔄 Session disconnected, attempting reconnect for task ${taskId}...`);
                            taskInfo.reconnectAttempts++;
                            taskInfo.lastReconnect = new Date();
                            
                            if (taskInfo.reconnectAttempts > taskInfo.maxReconnectAttempts) {
                                console.log(`❌ Max reconnection attempts reached for task ${taskId}`);
                                taskInfo.error = "Max reconnection attempts reached";
                                break;
                            }
                            
                            const reconnected = await ensureSessionConnected(sessionInfo, sessionId);
                            if (!reconnected) {
                                console.log(`❌ Reconnection failed for task ${taskId}`);
                                await delay(5000); // Wait before retry
                                sendAttempts++;
                                continue;
                            }
                            
                            waClient = sessionInfo.client; // Update client reference
                            console.log(`✅ Reconnected successfully for task ${taskId}`);
                        }

                        let msg = messages[index];
                        if (taskInfo.prefix) msg = `${taskInfo.prefix} ${msg}`;
                        
                        const recipient = taskInfo.targetType === "group"
                            ? (taskInfo.target.includes('@g.us') ? taskInfo.target : taskInfo.target + '@g.us')
                            : (taskInfo.target.includes('@s.whatsapp.net') ? taskInfo.target : taskInfo.target + '@s.whatsapp.net');

                        await waClient.sendMessage(recipient, { text: msg });

                        taskInfo.sentMessages++;
                        taskInfo.lastUpdate = new Date();
                        messageSent = true;
                        taskInfo.reconnectAttempts = 0; // Reset reconnect counter on success
                        
                        // Show progress every 10 messages
                        if (taskInfo.sentMessages % 10 === 0 || taskInfo.sentMessages === taskInfo.totalMessages) {
                            console.log(`[${taskId}] Progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);
                        }
                        
                    } catch (sendErr) {
                        console.error(`[${taskId}] Send error (attempt ${sendAttempts + 1}):`, sendErr.message);
                        sendAttempts++;
                        
                        if (sendErr.message?.includes("closed") || sendErr.message?.includes("disconnected") || 
                            sendErr.message?.includes("not connected") || sendErr.message?.includes("timeout")) {
                            
                            // Mark session as disconnected to trigger reconnect
                            sessionInfo.registered = false;
                            sessionInfo.isConnecting = false;
                            
                            if (sendAttempts < maxSendAttempts) {
                                console.log(`🔄 Will retry message after reconnect...`);
                                await delay(3000); // Wait before retry
                            }
                        } else {
                            // Other errors (like rate limiting), wait and retry
                            if (sendAttempts < maxSendAttempts) {
                                const waitTime = 10000; // 10 seconds for rate limits
                                console.log(`⏰ Waiting ${waitTime/1000}s before retry...`);
                                await delay(waitTime);
                            }
                        }
                    }
                }

                if (!messageSent && !taskInfo.stopRequested) {
                    console.error(`[${taskId}] Failed to send message after ${maxSendAttempts} attempts: "${messages[index]}"`);
                    taskInfo.error = `Failed to send message after ${maxSendAttempts} attempts`;
                    // Continue with next message instead of breaking
                    taskInfo.sentMessages++; // Count as attempted
                }

                // DELAY BETWEEN MESSAGES (only if not stopped)
                if (!taskInfo.stopRequested && index < messages.length - 1) {
                    const waitMs = parseFloat(delaySec) * 1000;
                    const chunkSize = 1000; // Check every second if stopped
                    const chunks = Math.ceil(waitMs / chunkSize);
                    
                    for (let t = 0; t < chunks && !taskInfo.stopRequested; t++) {
                        await delay(chunkSize);
                    }
                }
                
                if (taskInfo.stopRequested) break;
            }
        } catch (error) {
            console.error(`[${taskId}] Task execution error:`, error);
            taskInfo.error = error.message;
        } finally {
            taskInfo.endTime = new Date();
            taskInfo.isSending = false;
            taskInfo.completed = !taskInfo.stopRequested;
            safeDeleteFile(filePath);
            
            const status = taskInfo.stopRequested ? "STOPPED" : "COMPLETED";
            console.log(`[${taskId}] ${status}: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);
            
            // Keep completed tasks in memory for longer (30 minutes)
            setTimeout(() => {
                if (activeTasks.has(taskId)) {
                    activeTasks.delete(taskId);
                    console.log(`[${taskId}] Removed from memory`);
                }
            }, 30 * 60 * 1000);
        }
    })();
});

// --- IMPROVED SESSION INITIALIZATION ---
async function initializeClient(sessionId, sessionInfo) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionInfo.authPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000, // Keep connection alive
            emitOwnEvents: true,
            retryRequestDelayMs: 250,
            maxRetries: 5,
        });

        sessionInfo.client = waClient;
        sessionInfo.isConnecting = true;

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(`🔗 Connection update for session ${sessionId}: ${connection}`);
            
            if (connection === "open") {
                console.log(`✅ WhatsApp Connected for ${sessionInfo.number}!`);
                
                try {
                    const user = waClient.user;
                    sessionInfo.deviceInfo = {
                        platform: user?.platform || "WhatsApp Web",
                        pairedAt: new Date().toISOString(),
                        browser: "Chrome",
                        phoneNumber: user?.id?.split(':')[0] || sessionInfo.number,
                        deviceType: "Browser",
                        connection: "Active"
                    };
                    
                    sessionInfo.pairedAt = new Date();
                } catch (deviceErr) {
                    console.log("⚠️ Could not capture device info:", deviceErr);
                }
                
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
                
                console.log(`✅ Session fully initialized: ${sessionId}`);
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Connection closed for session ${sessionId}, status: ${statusCode}`);
                
                if (statusCode === 401) {
                    console.log(`🚫 Auth error for ${sessionId}`);
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                } else {
                    sessionInfo.reconnectAttempts = (sessionInfo.reconnectAttempts || 0) + 1;
                    if (sessionInfo.reconnectAttempts <= 5) {
                        console.log(`🔄 Auto-reconnection attempt ${sessionInfo.reconnectAttempts} for ${sessionId} in 5s...`);
                        setTimeout(() => {
                            if (activeClients.has(sessionId) && !sessionInfo.stopRequested) {
                                initializeClient(sessionId, sessionInfo);
                            }
                        }, 5000);
                    } else {
                        console.log(`🚫 Max auto-reconnection attempts reached for ${sessionId}`);
                        sessionInfo.isConnecting = false;
                    }
                }
            }
        });

    } catch (err) {
        console.error(`Reconnection failed for ${sessionId}`, err);
        sessionInfo.isConnecting = false;
        sessionInfo.reconnectAttempts = (sessionInfo.reconnectAttempts || 0) + 1;
        
        // Retry after 10 seconds
        if (sessionInfo.reconnectAttempts <= 5) {
            setTimeout(() => {
                if (activeClients.has(sessionId) && !sessionInfo.stopRequested) {
                    initializeClient(sessionId, sessionInfo);
                }
            }, 10000);
        }
    }
}

// --- KEEP SESSIONS ALIVE ---
setInterval(() => {
    activeClients.forEach((sessionInfo, sessionId) => {
        if (sessionInfo.client && sessionInfo.registered && !sessionInfo.isConnecting) {
            try {
                // Send a keep-alive ping to maintain connection
                sessionInfo.client.sendPresenceUpdate('available');
            } catch (error) {
                console.log(`⚠️ Keep-alive failed for ${sessionId}, will reconnect...`);
                sessionInfo.registered = false;
                initializeClient(sessionId, sessionInfo);
            }
        }
    });
}, 5 * 60 * 1000); // Every 5 minutes

// (Rest of the endpoints remain the same - user-sessions, groups, stop-task, etc.)
// Include all the other endpoints from your original code here...

app.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp Bulk Server FIXED Version Started!`);
    console.log(`📍 Server running at http://localhost:${PORT}`);
    console.log(`🔧 Improvements: Auto-reconnect, No 2-hour limit, Better error handling`);
    console.log(`⚡ Tasks will run until manually stopped!`);
});
