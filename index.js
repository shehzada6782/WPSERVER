// index.js (WhatsApp Bulk Sender with Enhanced Auto-Reconnect)
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
if (!fs.existsSync("logs")) fs.mkdirSync("logs", { recursive: true });

// Enhanced logging
const logger = pino({
    level: 'info',
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: { 
                    colorize: true,
                    translateTime: 'SYS:standard'
                }
            },
            {
                target: 'pino/file',
                options: { 
                    destination: path.join(__dirname, 'logs', 'whatsapp.log'),
                    mkdir: true 
                }
            }
        ]
    }
});

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
const userSessions = new Map();
const messageQueues = new Map(); // 🔄 NEW: Message queue for each session

// Utility functions
function safeDeleteFile(p) {
    try { 
        if (p && fs.existsSync(p)) {
            fs.unlinkSync(p); 
            logger.info(`🗑️ Deleted file: ${p}`);
        }
    } catch (e) { 
        logger.error(`Error deleting file ${p}:`, e);
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

// 🛡️ ENHANCED: Connection stability check
function isConnectionHealthy(sessionInfo) {
    if (!sessionInfo.registered || !sessionInfo.client) return false;
    
    // Check if last activity was within 2 minutes
    const timeSinceLastActivity = Date.now() - sessionInfo.lastActivity.getTime();
    return timeSinceLastActivity < 120000;
}

// 🆕 NEW: Queue management for uninterrupted sending
function initializeMessageQueue(sessionId) {
    if (!messageQueues.has(sessionId)) {
        messageQueues.set(sessionId, {
            messages: [],
            isProcessing: false,
            retryCount: 0,
            maxRetries: 3
        });
    }
    return messageQueues.get(sessionId);
}

// 🆕 NEW: Process message queue
async function processMessageQueue(sessionInfo) {
    const sessionId = sessionInfo.sessionId;
    const queue = messageQueues.get(sessionId);
    
    if (!queue || queue.isProcessing || queue.messages.length === 0) return;
    
    queue.isProcessing = true;
    
    while (queue.messages.length > 0 && !queue.stopRequested) {
        const messageJob = queue.messages[0];
        
        try {
            // 🛡️ Connection health check before each message
            if (!isConnectionHealthy(sessionInfo)) {
                logger.warn(`🔄 Connection unhealthy, attempting reconnect before sending...`);
                await initializeWhatsAppSession(sessionInfo, true);
                await delay(3000); // Wait for reconnection
            }
            
            await sessionInfo.client.sendMessage(messageJob.recipient, { text: messageJob.text });
            
            // Success - remove from queue
            queue.messages.shift();
            queue.retryCount = 0; // Reset retry count on success
            
            // Update task progress
            if (messageJob.taskId && activeTasks.has(messageJob.taskId)) {
                const task = activeTasks.get(messageJob.taskId);
                task.sentMessages++;
                task.lastUpdate = new Date();
                task.lastSuccessTime = new Date();
            }
            
            sessionInfo.lastActivity = new Date();
            
        } catch (sendErr) {
            logger.error(`[Queue] Send error for ${sessionId}:`, sendErr.message);
            queue.retryCount++;
            
            if (queue.retryCount >= queue.maxRetries) {
                logger.error(`[Queue] Max retries exceeded, removing message:`, messageJob);
                queue.messages.shift();
                queue.retryCount = 0;
            } else {
                // Wait before retry
                await delay(2000);
            }
        }
        
        // Respect delay between messages
        if (messageJob.delayMs > 0) {
            await delay(messageJob.delayMs);
        }
    }
    
    queue.isProcessing = false;
}

// Enhanced session initialization with auto-reconnect
async function initializeWhatsAppSession(sessionInfo, isReconnect = false) {
    const { sessionId, authPath, number, ownerId } = sessionInfo;
    
    try {
        logger.info(`${isReconnect ? '🔄 Reinitializing' : '🚀 Initializing'} session: ${sessionId}`);
        
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        // Enhanced socket configuration for stability
        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: true,
            logger: pino({ 
                level: "error",
                transport: {
                    target: 'pino-pretty',
                    options: { colorize: true }
                }
            }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 2000,
            maxRetries: 10,
            emitOwnEvents: true,
            generateHighQualityLinkPreview: true,
            fireInitQueries: true
        });

        // Update session info
        sessionInfo.client = waClient;
        sessionInfo.isConnecting = true;
        sessionInfo.reconnectAttempts = isReconnect ? (sessionInfo.reconnectAttempts || 0) + 1 : 0;
        sessionInfo.lastActivity = new Date();

        // Handle credentials update
        waClient.ev.on("creds.update", saveCreds);
        
        // Enhanced connection handling
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;
            
            logger.info(`🔗 Connection update for ${sessionId}: ${connection}`);
            sessionInfo.lastActivity = new Date();
            
            if (connection === "open") {
                logger.info(`✅ WhatsApp Connected for ${number}! (Session: ${sessionId})`);
                
                // Update session status
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
                sessionInfo.connectionEstablished = new Date();
                sessionInfo.lastSuccessfulConnection = new Date();
                
                // Start keep-alive mechanism
                startKeepAlive(sessionInfo);
                
                // 🆕 NEW: Resume any pending message queues
                if (messageQueues.has(sessionId)) {
                    const queue = messageQueues.get(sessionId);
                    if (queue.messages.length > 0) {
                        logger.info(`🔄 Resuming ${queue.messages.length} queued messages for ${sessionId}`);
                        processMessageQueue(sessionInfo);
                    }
                }
                
                // Fetch groups immediately after connection
                await fetchSessionGroups(sessionInfo);
                
                if (sessionInfo.connectionResolve) {
                    sessionInfo.connectionResolve();
                    sessionInfo.connectionResolve = null;
                }
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = shouldAttemptReconnect(lastDisconnect?.error);
                
                logger.warn(`❌ Connection closed for ${sessionId}, status: ${statusCode}, shouldReconnect: ${shouldReconnect}`);
                
                // Stop keep-alive
                stopKeepAlive(sessionInfo);
                
                if (statusCode === DisconnectReason.loggedOut || isNewLogin) {
                    logger.error(`🚫 Logged out from ${sessionId}`);
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                    sessionInfo.forceReconnect = false;
                    
                    // Clean up session files
                    try {
                        if (fs.existsSync(authPath)) {
                            fs.rmSync(authPath, { recursive: true, force: true });
                            logger.info(`🧹 Deleted session files for ${sessionId}`);
                        }
                    } catch (cleanupError) {
                        logger.error(`Error cleaning up session files:`, cleanupError);
                    }
                    
                } else if (shouldReconnect) {
                    sessionInfo.isConnecting = true;
                    
                    // Implement exponential backoff for reconnection
                    const delayMs = Math.min(1000 * Math.pow(2, sessionInfo.reconnectAttempts), 30000);
                    logger.info(`🔄 Reconnection attempt ${sessionInfo.reconnectAttempts + 1} for ${sessionId} in ${delayMs/1000}s...`);
                    
                    setTimeout(async () => {
                        if (activeClients.has(sessionId) && sessionInfo.forceReconnect !== false) {
                            await initializeWhatsAppSession(sessionInfo, true);
                        }
                    }, delayMs);
                    
                } else {
                    sessionInfo.isConnecting = false;
                    logger.error(`🚫 Max reconnection attempts or unrecoverable error for ${sessionId}`);
                }
                
                if (sessionInfo.connectionReject) {
                    sessionInfo.connectionReject(new Error(`Connection closed: ${statusCode}`));
                    sessionInfo.connectionReject = null;
                }
            }
            
            // Handle QR code for new connections
            if (qr && !sessionInfo.registered) {
                logger.info(`📱 QR code received for ${sessionId}`);
                handleQRCode(sessionInfo, qr, number);
            }
        });

        // Handle messages and other events for keep-alive
        waClient.ev.on("messages.upsert", () => {
            sessionInfo.lastActivity = new Date();
        });

        // 🆕 NEW: Monitor for any connection issues
        waClient.ev.on("connection.phone-connection", (phoneConnection) => {
            if (phoneConnection?.connected === false) {
                logger.warn(`📱 Phone connection lost for ${sessionId}`);
            }
        });

        return waClient;

    } catch (error) {
        logger.error(`❌ Session initialization failed for ${sessionId}:`, error);
        sessionInfo.isConnecting = false;
        throw error;
    }
}

// Enhanced reconnection logic
function shouldAttemptReconnect(error) {
    if (!error) return true;
    
    const statusCode = error.output?.statusCode;
    const errorMessage = error.message || '';
    
    // Don't reconnect for these errors
    const nonRecoverableErrors = [
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.restartRequired,
        DisconnectReason.multideviceMismatch
    ];
    
    if (nonRecoverableErrors.includes(statusCode)) {
        return false;
    }
    
    // Don't reconnect for authentication errors
    if (errorMessage.includes('auth') || errorMessage.includes('401')) {
        return false;
    }
    
    return true;
}

// Keep-alive mechanism
function startKeepAlive(sessionInfo) {
    stopKeepAlive(sessionInfo); // Clear existing interval
    
    // Send periodic presence updates to keep connection alive
    sessionInfo.keepAliveInterval = setInterval(async () => {
        try {
            if (sessionInfo.client && sessionInfo.registered) {
                await sessionInfo.client.sendPresenceUpdate('available');
                
                // Periodically update last seen
                if (Date.now() - sessionInfo.lastActivity.getTime() > 60000) {
                    sessionInfo.lastActivity = new Date();
                }
                
                logger.debug(`💓 Keep-alive sent for ${sessionInfo.sessionId}`);
            }
        } catch (error) {
            logger.warn(`Keep-alive failed for ${sessionInfo.sessionId}:`, error.message);
        }
    }, 25000); // Every 25 seconds
    
    // Additional activity simulation every 2 minutes
    sessionInfo.activityInterval = setInterval(async () => {
        try {
            if (sessionInfo.client && sessionInfo.registered) {
                await sessionInfo.client.updateProfileStatus('Active via Bulk Sender');
                logger.debug(`🔄 Activity simulation for ${sessionInfo.sessionId}`);
            }
        } catch (error) {
            logger.debug(`Activity simulation failed for ${sessionInfo.sessionId}:`, error.message);
        }
    }, 120000); // Every 2 minutes
    
    // 🆕 NEW: Connection health monitor every 30 seconds
    sessionInfo.healthCheckInterval = setInterval(async () => {
        if (!isConnectionHealthy(sessionInfo) && sessionInfo.registered) {
            logger.warn(`🩺 Connection health check failed for ${sessionInfo.sessionId}, forcing reconnect...`);
            await initializeWhatsAppSession(sessionInfo, true);
        }
    }, 30000);
}

function stopKeepAlive(sessionInfo) {
    if (sessionInfo.keepAliveInterval) {
        clearInterval(sessionInfo.keepAliveInterval);
        sessionInfo.keepAliveInterval = null;
    }
    if (sessionInfo.activityInterval) {
        clearInterval(sessionInfo.activityInterval);
        sessionInfo.activityInterval = null;
    }
    if (sessionInfo.healthCheckInterval) {
        clearInterval(sessionInfo.healthCheckInterval);
        sessionInfo.healthCheckInterval = null;
    }
}

// Fetch groups for session
async function fetchSessionGroups(sessionInfo) {
    try {
        const { client: waClient, sessionId } = sessionInfo;
        
        if (!waClient) {
            logger.warn(`No client available for group fetch: ${sessionId}`);
            return;
        }

        logger.info(`📋 Fetching groups for session: ${sessionId}`);
        
        const groupData = await waClient.groupFetchAllParticipating();
        
        const groups = Object.values(groupData).map(group => ({
            id: group.id,
            name: group.subject || 'Unknown Group',
            participants: group.participants ? group.participants.length : 0,
            isAnnouncement: group.announcement || false,
            isLocked: group.locked || false,
            creation: group.creation ? new Date(group.creation * 1000).toISOString() : null,
            subjectOwner: group.subjectOwner,
            subjectTime: group.subjectTime ? new Date(group.subjectTime * 1000).toISOString() : null
        })).sort((a, b) => a.name.localeCompare(b.name));

        // Cache the groups
        sessionInfo.groups = groups;
        sessionInfo.groupsLastFetched = Date.now();

        logger.info(`✅ Found ${groups.length} groups for ${sessionInfo.number}`);

    } catch (error) {
        logger.error(`❌ Error fetching groups for ${sessionInfo.sessionId}:`, error);
    }
}

// Handle QR code
function handleQRCode(sessionInfo, qr, number) {
    let actualPairingCode = null;
    
    try {
        // Try to extract pairing code from QR
        const qrMatch = qr.match(/[A-Z0-9]{6,8}/);
        if (qrMatch) {
            actualPairingCode = qrMatch[0];
            logger.info(`✅ Extracted pairing code from QR: ${actualPairingCode}`);
        }
    } catch (qrError) {
        logger.warn(`QR extraction failed:`, qrError.message);
    }
    
    if (!actualPairingCode && qr && qr.length >= 6 && qr.length <= 8) {
        actualPairingCode = qr;
        logger.info(`✅ Using QR as pairing code: ${actualPairingCode}`);
    }
    
    if (actualPairingCode) {
        sessionInfo.pairingCode = actualPairingCode;
    }
}

// Auto-reconnect service for all sessions
function startAutoReconnectService() {
    setInterval(() => {
        activeClients.forEach(async (sessionInfo, sessionId) => {
            try {
                // Check if session is registered but client is not connected
                if (sessionInfo.registered && 
                    sessionInfo.forceReconnect !== false &&
                    !isConnectionHealthy(sessionInfo)
                ) {
                    logger.warn(`🔄 Auto-reconnecting unhealthy session: ${sessionId}`);
                    await initializeWhatsAppSession(sessionInfo, true);
                }
            } catch (error) {
                logger.error(`Auto-reconnect failed for ${sessionId}:`, error);
            }
        });
    }, 45000); // Check every 45 seconds
}

// Start auto-reconnect service when server starts
setTimeout(startAutoReconnectService, 30000);

// --- API ENDPOINTS ---

// Get user sessions
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
            isConnecting: info.isConnecting || false,
            deviceInfo: info.deviceInfo || null,
            groups: info.groups || [],
            totalGroups: info.groups ? info.groups.length : 0,
            lastActivity: info.lastActivity,
            connectionEstablished: info.connectionEstablished,
            reconnectAttempts: info.reconnectAttempts || 0,
            queueSize: messageQueues.get(id)?.messages.length || 0 // 🆕 NEW: Queue status
        }));

    res.json({
        userId: userId,
        sessions: sessions,
        total: sessions.length,
        userCreated: userSession.createdAt,
        lastActive: userSession.lastActive
    });
});

// 🛠️ FIXED: /groups endpoint - removed duplicate code and syntax errors
app.get("/groups", async (req, res) => {
    const { sessionId, userId } = req.query;
    
    if (!sessionId || !userId) {
        return res.status(400).json({ error: "Session ID and User ID are required" });
    }

    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    if (sessionInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    try {
        await fetchSessionGroups(sessionInfo);
        
        res.json({
            success: true,
            groups: sessionInfo.groups || [],
            total: sessionInfo.groups ? sessionInfo.groups.length : 0,
            cached: false
        });

    } catch (error) {
        logger.error(`Error fetching groups for ${sessionId}:`, error);
        res.status(500).json({ 
            error: "Failed to fetch groups: " + (error.message || "Unknown error")
        });
    }
}); // ✅ FIXED: Properly closed endpoint

// Pair new number
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
            
            // Create session info for already registered session
            const sessionInfo = {
                sessionId: sessionId, // 🆕 NEW: Ensure sessionId is set
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
                groupsLastFetched: null,
                lastActivity: new Date(),
                forceReconnect: true
            };
            
            activeClients.set(sessionId, sessionInfo);
            initializeMessageQueue(sessionId); // 🆕 NEW: Initialize message queue
            
            // Initialize the client in background
            initializeWhatsAppSession(sessionInfo).catch(error => {
                logger.error(`Background initialization failed for ${sessionId}:`, error);
            });
            
            return res.json({ 
                pairingCode: displayCode,
                waCode: "ALREADY_REGISTERED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered and ready to use",
                deviceInfo: sessionInfo.deviceInfo,
                groups: sessionInfo.groups,
                totalGroups: sessionInfo.groups.length
            });
        }

        // Create new session
        const sessionInfo = {
            sessionId: sessionId, // 🆕 NEW: Ensure sessionId is set
            client: null,
            number: num,
            authPath: sessionPath,
            registered: false,
            pairingCode: generateDisplayCode(),
            ownerId: userId,
            isConnecting: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 10,
            deviceInfo: null,
            pairedAt: null,
            groups: [],
            groupsLastFetched: null,
            lastActivity: new Date(),
            forceReconnect: true
        };

        activeClients.set(sessionId, sessionInfo);
        initializeMessageQueue(sessionId); // 🆕 NEW: Initialize message queue

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
                logger.warn(`⏰ Connection timeout for ${sessionId}`);
                rejectRequest("Connection timeout. Please try again.");
            }
        }, 180000);

        // Initialize the session
        initializeWhatsAppSession(sessionInfo)
            .then(waClient => {
                // Set up connection promise for QR code handling
                sessionInfo.connectionResolve = () => {
                    resolveRequest({ 
                        pairingCode: "CONNECTED",
                        waCode: "CONNECTED",
                        sessionId: sessionId,
                        status: "connected",
                        message: "WhatsApp connected successfully!",
                        deviceInfo: sessionInfo.deviceInfo,
                        groups: sessionInfo.groups || [],
                        totalGroups: sessionInfo.groups ? sessionInfo.groups.length : 0
                    });
                };
                
                sessionInfo.connectionReject = rejectRequest;

                // Try to get pairing code directly
                setTimeout(async () => {
                    if (!isResolved) {
                        try {
                            const pairingCode = await waClient.requestPairingCode(num);
                            if (pairingCode) {
                                logger.info(`✅ Got pairing code directly: ${pairingCode}`);
                                sessionInfo.pairingCode = pairingCode;
                                
                                resolveRequest({ 
                                    pairingCode: pairingCode,
                                    waCode: pairingCode,
                                    sessionId: sessionId,
                                    status: "code_received", 
                                    message: `Use code in WhatsApp: ${pairingCode}`
                                });
                            }
                        } catch (error) {
                            logger.debug(`Direct pairing code not available yet:`, error.message);
                        }
                    }
                }, 5000);

            })
            .catch(error => {
                logger.error(`Session initialization failed:`, error);
                rejectRequest(error.message || "Failed to initialize session");
            });

    } catch (err) {
        logger.error("❌ Session creation error:", err);
        activeClients.delete(sessionId);
        messageQueues.delete(sessionId); // 🆕 NEW: Clean up queue
        return res.status(500).json({ error: err.message || "Server error" });
    }
});

// 🚀 ENHANCED: Send message with queue system for uninterrupted sending
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
    
    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    // Use groupId if provided, otherwise use target
    let finalTarget = target;
    if (groupId && targetType === "group") {
        finalTarget = groupId;
    }
    
    if (!finalTarget) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "No target specified" });
    }

    let messages;
    try {
        messages = fs.readFileSync(filePath, "utf-8").split("\n").map(m => m.trim()).filter(Boolean);
        if (messages.length === 0) throw new Error("Message file empty");
    } catch (err) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid message file" });
    }

    const taskId = `TASK_${Date.now()}`;
    const delayMs = parseFloat(delaySec) * 1000;

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
        lastSuccessTime: new Date(),
        usingQueue: true // 🆕 NEW: Mark as using queue system
    };

    activeTasks.set(taskId, taskInfo);
    
    // 🆕 NEW: Add messages to queue instead of sending immediately
    const queue = initializeMessageQueue(sessionId);
    const recipient = taskInfo.targetType === "group"
        ? (taskInfo.target.includes('@g.us') ? taskInfo.target : taskInfo.target + '@g.us')
        : (taskInfo.target.includes('@s.whatsapp.net') ? taskInfo.target : taskInfo.target + '@s.whatsapp.net');

    messages.forEach((message, index) => {
        let msg = message;
        if (taskInfo.prefix) msg = `${taskInfo.prefix} ${msg}`;
        
        queue.messages.push({
            text: msg,
            recipient: recipient,
            taskId: taskId,
            delayMs: delayMs,
            addedAt: new Date()
        });
    });

    // Start processing the queue
    processMessageQueue(sessionInfo);
    
    // RETURN TASK ID CLEARLY
    res.json({ 
        success: true,
        taskId: taskId,
        status: "queued", 
        totalMessages: messages.length,
        queuedMessages: queue.messages.length,
        message: `📨 Task QUEUED! ${messages.length} messages added to queue. Use ID to stop: ${taskId}`
    });

    logger.info(`🚀 Task QUEUED: ${taskId}`);
    logger.info(`📝 Messages: ${messages.length}, Target: ${finalTarget}, Delay: ${delaySec}s, User: ${taskInfo.ownerId}`);

    safeDeleteFile(filePath);
});

// 🆕 NEW: Enhanced task status with queue information
app.get("/task-status", (req, res) => {
    const { taskId } = req.query;
    
    if (!taskId || !activeTasks.has(taskId)) {
        return res.status(404).json({ error: "Task not found" });
    }
    
    const task = activeTasks.get(taskId);
    const queue = messageQueues.get(task.sessionId);
    
    res.json({
        taskId: task.taskId,
        status: task.isSending ? (task.stopRequested ? "stopping" : "sending") : "completed",
        progress: {
            sent: task.sentMessages,
            total: task.totalMessages,
            percentage: Math.round((task.sentMessages / task.totalMessages) * 100)
        },
        queueInfo: queue ? {
            queued: queue.messages.filter(m => m.taskId === taskId).length,
            processing: queue.isProcessing
        } : null,
        timing: {
            start: task.startTime,
            lastUpdate: task.lastUpdate,
            end: task.endTime
        },
        usingQueue: task.usingQueue || false
    });
});

// 🆕 NEW: Enhanced stop task that also clears queue
app.post("/stop-task", upload.none(), async (req, res) => {
    const { taskId, userId } = req.body;
    
    if (!taskId) return res.status(400).json({ error: "Task ID is required" });
    if (!userId) return res.status(400).json({ error: "User ID is required" });
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: "Task not found" });
    }

    const task = activeTasks.get(taskId);
    
    if (task.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This task does not belong to you." });
    }

    // Stop the task
    task.stopRequested = true;
    task.isSending = false;
    task.endTime = new Date();
    
    // 🆕 NEW: Also remove queued messages for this task
    if (messageQueues.has(task.sessionId)) {
        const queue = messageQueues.get(task.sessionId);
        queue.messages = queue.messages.filter(msg => msg.taskId !== taskId);
        logger.info(`🧹 Removed queued messages for task: ${taskId}`);
    }
    
    logger.info(`⏹️ Task stopped: ${taskId}`);
    
    res.json({ 
        success: true, 
        message: `Task ${taskId} stopped successfully`,
        finalProgress: {
            sent: task.sentMessages,
            total: task.totalMessages
        }
    });
});

// Enhanced session deletion
app.post("/delete-session", upload.none(), async (req, res) => {
    const { sessionId, userId } = req.body;
    
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    if (!userId) return res.status(400).json({ error: "User ID is required" });
    
    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    if (sessionInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    try {
        // Stop keep-alive
        stopKeepAlive(sessionInfo);
        
        // Mark session for no reconnection
        sessionInfo.forceReconnect = false;
        
        // 🆕 NEW: Stop all tasks for this session
        activeTasks.forEach((task, taskId) => {
            if (task.sessionId === sessionId) {
                task.stopRequested = true;
                task.isSending = false;
            }
        });
        
        // 🆕 NEW: Clear message queue
        if (messageQueues.has(sessionId)) {
            messageQueues.delete(sessionId);
        }
        
        if (sessionInfo.client) {
            sessionInfo.client.end();
            logger.info(`🔌 Disconnected client for session: ${sessionId}`);
        }
        
        // Delete session files
        if (sessionInfo.authPath && fs.existsSync(sessionInfo.authPath)) {
            fs.rmSync(sessionInfo.authPath, { recursive: true, force: true });
            logger.info(`🗑️ Deleted session files: ${sessionInfo.authPath}`);
        }
        
        activeClients.delete(sessionId);
        logger.info(`✅ Session deleted: ${sessionId}`);
        
        res.json({ 
            success: true, 
            message: `Session ${sessionId} deleted successfully` 
        });
        
    } catch (err) {
        logger.error(`Error deleting session ${sessionId}:`, err);
        res.status(500).json({ error: "Failed to delete session" });
    }
});

// Enhanced health check with queue information
app.get("/health", (req, res) => {
    const now = new Date();
    const activeSessions = [...activeClients.values()].filter(s => s.registered && !s.isConnecting).length;
    const connectingSessions = [...activeClients.values()].filter(s => s.isConnecting).length;
    
    // Calculate queue statistics
    let totalQueued = 0;
    messageQueues.forEach(queue => {
        totalQueued += queue.messages.length;
    });
    
    res.json({
        status: "OK",
        timestamp: now.toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sessions: {
            total: activeClients.size,
            active: activeSessions,
            connecting: connectingSessions,
            inactive: activeClients.size - activeSessions - connectingSessions
        },
        tasks: {
            total: activeTasks.size,
            active: [...activeTasks.values()].filter(t => t.isSending).length
        },
        queues: {
            totalSessionsWithQueues: messageQueues.size,
            totalQueuedMessages: totalQueued
        },
        users: userSessions.size
    });
});

// Other existing endpoints (user-tasks, user-stats, etc.) remain similar

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('\n🛑 Shutting down gracefully...');
    
    // Stop all keep-alive intervals
    activeClients.forEach((sessionInfo) => {
        stopKeepAlive(sessionInfo);
    });
    
    // Close all WhatsApp connections
    activeClients.forEach(({ client }, sessionId) => {
        try { 
            if (client) {
                client.end(); 
                logger.info(`🔌 Closed WhatsApp session: ${sessionId}`);
            }
        } catch (e) { 
            logger.error(`Error closing session ${sessionId}:`, e);
        }
    });
    
    // Cleanup temp files
    try {
        if (fs.existsSync('uploads')) {
            fs.rmSync('uploads', { recursive: true, force: true });
            logger.info('🧹 Cleaned up uploads directory');
        }
    } catch (e) {
        logger.error('Error cleaning up uploads:', e);
    }
    
    logger.info('✅ Server shutdown complete');
    process.exit(0);
});

app.listen(PORT, () => {
    logger.info(`

📊 Enhanced logging with queue statistics
⚡ Ready to send bulk messages with maximum stability!
    `);
});
