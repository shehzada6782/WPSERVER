// index.js (Multi-user WhatsApp Bulk Sender - PERSISTENT VERSION)
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

// --- AUTO-RECONNECT SYSTEM ---
async function initializeClient(sessionId, sessionInfo, isReconnect = false) {
    try {
        console.log(`${isReconnect ? '🔄 Reconnecting' : '🔌 Initializing'} client for session: ${sessionId}`);
        
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
            keepAliveIntervalMs: 30000, // Send keep-alive every 30 seconds
            emitOwnEvents: true,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            retryRequestDelayMs: 2000,
            maxRetries: 5,
            fireInitQueries: true
        });

        sessionInfo.client = waClient;
        sessionInfo.isConnecting = true;
        sessionInfo.reconnectCount = (sessionInfo.reconnectCount || 0) + 1;

        let connectionTimeout;
        let isConnected = false;

        const setupConnectionTimeout = () => {
            clearTimeout(connectionTimeout);
            connectionTimeout = setTimeout(() => {
                if (!isConnected && activeClients.has(sessionId)) {
                    console.log(`⏰ Connection timeout for ${sessionId}, reconnecting...`);
                    if (sessionInfo.reconnectCount <= 5) {
                        setTimeout(() => initializeClient(sessionId, sessionInfo, true), 5000);
                    } else {
                        console.log(`🚫 Max connection attempts reached for ${sessionId}`);
                        sessionInfo.isConnecting = false;
                    }
                }
            }, 120000);
        };

        setupConnectionTimeout();

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
            
            console.log(`🔗 Connection update for ${sessionId}: ${connection}`);
            
            if (connection === "open") {
                console.log(`✅ WhatsApp CONNECTED for ${sessionInfo.number}! (User: ${sessionInfo.ownerId})`);
                isConnected = true;
                clearTimeout(connectionTimeout);
                
                // CAPTURE DEVICE INFO
                try {
                    const user = waClient.user;
                    sessionInfo.deviceInfo = {
                        platform: user?.platform || "WhatsApp Web",
                        pairedAt: sessionInfo.pairedAt || new Date().toISOString(),
                        browser: "Chrome",
                        phoneNumber: user?.id?.split(':')[0] || sessionInfo.number,
                        deviceType: "Browser",
                        connection: "Active",
                        lastConnected: new Date().toISOString(),
                        reconnectCount: sessionInfo.reconnectCount || 0
                    };
                    
                    if (!sessionInfo.pairedAt) {
                        sessionInfo.pairedAt = new Date();
                    }
                } catch (deviceErr) {
                    console.log("⚠️ Could not capture device info:", deviceErr);
                }
                
                // FETCH GROUPS
                try {
                    console.log(`📋 Fetching groups for ${sessionId}`);
                    const groupData = await waClient.groupFetchAllParticipating();
                    
                    const groups = Object.values(groupData).map(group => ({
                        id: group.id,
                        name: group.subject || 'Unknown Group',
                        participants: group.participants ? group.participants.length : 0,
                        isAnnouncement: group.announcement || false,
                        isLocked: group.locked || false,
                        creation: group.creation ? new Date(group.creation * 1000).toISOString() : null
                    })).sort((a, b) => a.name.localeCompare(b.name));
                    
                    sessionInfo.groups = groups;
                    sessionInfo.groupsLastFetched = Date.now();
                    console.log(`✅ Found ${groups.length} groups for ${sessionInfo.number}`);
                } catch (groupError) {
                    console.log("⚠️ Could not fetch groups:", groupError.message);
                }
                
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
                sessionInfo.lastConnection = new Date();
                
                // Schedule periodic connection health check
                if (sessionInfo.healthCheckInterval) {
                    clearInterval(sessionInfo.healthCheckInterval);
                }
                
                sessionInfo.healthCheckInterval = setInterval(() => {
                    if (activeClients.has(sessionId) && sessionInfo.registered) {
                        checkConnectionHealth(sessionId, sessionInfo);
                    }
                }, 60000); // Check every minute
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message;
                console.log(`❌ Connection closed for ${sessionId}, status: ${statusCode}, error: ${errorMessage}`);
                
                isConnected = false;
                clearTimeout(connectionTimeout);
                sessionInfo.isConnecting = false;
                
                if (statusCode === 401 || statusCode === 403 || errorMessage?.includes("refused") || errorMessage?.includes("reset")) {
                    console.log(`🚫 Auth error for ${sessionId}, marking as disconnected`);
                    sessionInfo.registered = false;
                    sessionInfo.deviceInfo = {
                        ...sessionInfo.deviceInfo,
                        connection: "Disconnected - Authentication Failed",
                        lastError: new Date().toISOString()
                    };
                } else {
                    // Network or temporary error - attempt reconnect
                    sessionInfo.reconnectAttempts = (sessionInfo.reconnectAttempts || 0) + 1;
                    
                    if (sessionInfo.reconnectAttempts <= 10) { // Increased max attempts
                        const delayTime = Math.min(sessionInfo.reconnectAttempts * 5000, 30000); // Max 30 second delay
                        console.log(`🔄 Reconnection attempt ${sessionInfo.reconnectAttempts} for ${sessionId} in ${delayTime/1000}s...`);
                        
                        setTimeout(() => {
                            if (activeClients.has(sessionId) {
                                initializeClient(sessionId, sessionInfo, true);
                            }
                        }, delayTime);
                    } else {
                        console.log(`🚫 Max reconnection attempts reached for ${sessionId}`);
                        sessionInfo.registered = false;
                        sessionInfo.deviceInfo = {
                            ...sessionInfo.deviceInfo,
                            connection: "Disconnected - Max Retries",
                            lastError: new Date().toISOString()
                        };
                    }
                }
            }
            else if (connection === "connecting") {
                console.log(`🔄 Connecting to WhatsApp for ${sessionId}...`);
                setupConnectionTimeout();
            }
        });

        // Handle messages and other events to keep connection alive
        waClient.ev.on("messages.upsert", () => {
            // Activity detected - update last activity
            sessionInfo.lastActivity = new Date();
        });

    } catch (err) {
        console.error(`❌ Client initialization failed for ${sessionId}:`, err);
        sessionInfo.isConnecting = false;
        
        // Retry after delay
        setTimeout(() => {
            if (activeClients.has(sessionId)) {
                initializeClient(sessionId, sessionInfo, true);
            }
        }, 10000);
    }
}

// --- CONNECTION HEALTH CHECK ---
async function checkConnectionHealth(sessionId, sessionInfo) {
    try {
        if (!sessionInfo.client || !sessionInfo.registered) {
            return false;
        }

        const waClient = sessionInfo.client;
        
        // Simple health check - try to get our own user info
        if (waClient.user && waClient.user.id) {
            sessionInfo.connectionHealthy = true;
            sessionInfo.lastHealthCheck = new Date();
            return true;
        } else {
            console.log(`⚠️ Health check failed for ${sessionId}, reconnecting...`);
            sessionInfo.connectionHealthy = false;
            initializeClient(sessionId, sessionInfo, true);
            return false;
        }
    } catch (error) {
        console.log(`⚠️ Health check error for ${sessionId}:`, error.message);
        sessionInfo.connectionHealthy = false;
        initializeClient(sessionId, sessionInfo, true);
        return false;
    }
}

// --- PERIODIC CONNECTION MAINTENANCE ---
setInterval(() => {
    console.log(`🔍 Running connection maintenance check...`);
    let healthyCount = 0;
    let reconnectCount = 0;
    
    activeClients.forEach((sessionInfo, sessionId) => {
        if (sessionInfo.registered && !sessionInfo.isConnecting) {
            // Check if connection is older than 6 hours, force refresh
            const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
            if (sessionInfo.lastConnection && sessionInfo.lastConnection < sixHoursAgo) {
                console.log(`🔄 Refreshing 6+ hour old connection: ${sessionId}`);
                initializeClient(sessionId, sessionInfo, true);
                reconnectCount++;
            } else {
                healthyCount++;
            }
        }
    });
    
    console.log(`📊 Connection stats: ${healthyCount} healthy, ${reconnectCount} reconnecting`);
}, 30 * 60 * 1000); // Check every 30 minutes

// --- USER SESSIONS ENDPOINT ---
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
            connectionHealthy: info.connectionHealthy || false,
            lastConnection: info.lastConnection,
            reconnectCount: info.reconnectCount || 0
        }));

    res.json({
        userId: userId,
        sessions: sessions,
        total: sessions.length,
        userCreated: userSession.createdAt,
        lastActive: userSession.lastActive
    });
});

// --- GET GROUPS FOR SESSION ---
app.get("/groups", async (req, res) => {
    const { sessionId, userId } = req.query;
    
    if (!sessionId || !userId) {
        return res.status(400).json({ error: "Session ID and User ID are required" });
    }

    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK OWNERSHIP
    if (sessionInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    try {
        // If groups are already cached and less than 5 minutes old, return them
        if (sessionInfo.groups && sessionInfo.groupsLastFetched) {
            const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
            if (sessionInfo.groupsLastFetched > fiveMinutesAgo) {
                return res.json({
                    success: true,
                    groups: sessionInfo.groups,
                    total: sessionInfo.groups.length,
                    cached: true
                });
            }
        }

        const { client: waClient } = sessionInfo;
        
        if (!waClient) {
            return res.status(400).json({ error: "Client not initialized" });
        }

        console.log(`📋 Fetching groups for user ${userId}, session: ${sessionId}`);
        
        // Fetch groups from WhatsApp
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

        console.log(`✅ Found ${groups.length} groups for ${sessionInfo.number} (User: ${userId})`);

        res.json({
            success: true,
            groups: groups,
            total: groups.length,
            cached: false
        });

    } catch (error) {
        console.error(`❌ Error fetching groups for ${sessionId}:`, error);
        
        // If groups fetch fails, try to reconnect
        if (error.message?.includes("closed") || error.message?.includes("disconnected")) {
            console.log(`🔄 Attempting to reconnect due to groups fetch error...`);
            initializeClient(sessionId, sessionInfo, true);
        }
        
        res.status(500).json({ 
            error: "Failed to fetch groups: " + (error.message || "Unknown error"),
            details: "Attempting to reconnect..."
        });
    }
});

// --- REFRESH GROUPS ---
app.post("/refresh-groups", upload.none(), async (req, res) => {
    const { sessionId, userId } = req.body;
    
    if (!sessionId || !userId) {
        return res.status(400).json({ error: "Session ID and User ID are required" });
    }

    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK OWNERSHIP
    if (sessionInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    try {
        const { client: waClient } = sessionInfo;
        
        if (!waClient) {
            return res.status(400).json({ error: "Client not initialized" });
        }

        console.log(`🔄 Refreshing groups for user ${userId}, session: ${sessionId}`);
        
        // Clear cache and fetch fresh groups
        sessionInfo.groups = null;
        sessionInfo.groupsLastFetched = null;
        
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

        console.log(`✅ Refreshed ${groups.length} groups for ${sessionInfo.number} (User: ${userId})`);

        res.json({
            success: true,
            groups: groups,
            total: groups.length,
            message: `Successfully refreshed ${groups.length} groups`
        });

    } catch (error) {
        console.error(`❌ Error refreshing groups for ${sessionId}:`, error);
        res.status(500).json({ 
            error: "Failed to refresh groups: " + (error.message || "Unknown error")
        });
    }
});

// --- PAIR NEW NUMBER ---
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
                totalGroups: existingSession.groups ? existingSession.groups.length : 0,
                connectionHealthy: existingSession.connectionHealthy || false
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
            
            // Initialize client for already registered session
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
                    browser: "Chrome",
                    connection: "Needs Initialization"
                },
                pairedAt: new Date(),
                groups: [],
                groupsLastFetched: null,
                connectionHealthy: false
            };
            
            activeClients.set(sessionId, sessionInfo);
            
            // Initialize the client in background
            initializeClient(sessionId, sessionInfo, false);
            
            return res.json({ 
                pairingCode: displayCode,
                waCode: "ALREADY_REGISTERED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered. Initializing connection...",
                deviceInfo: sessionInfo.deviceInfo,
                groups: [],
                totalGroups: 0
            });
        }

        // For new pairing, use the existing flow but with improved connection management
        const displayCode = generateDisplayCode();
        const sessionInfo = {
            client: null,
            number: num,
            authPath: sessionPath,
            registered: false,
            pairingCode: displayCode,
            ownerId: userId,
            isConnecting: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 10,
            deviceInfo: null,
            pairedAt: null,
            groups: [],
            groupsLastFetched: null,
            connectionHealthy: false
        };

        activeClients.set(sessionId, sessionInfo);

        // Initialize client with QR code generation
        initializeClient(sessionId, sessionInfo, false);

        let connectionTimeout;
        let isResolved = false;

        const resolveRequest = (data) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            res.json(data);
        };

        const rejectRequest = (error) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            res.status(500).json({ error });
        };

        connectionTimeout = setTimeout(() => {
            if (!isResolved) {
                console.log(`⏰ Initial connection timeout for ${sessionId}`);
                // Don't reject, just return the current status
                resolveRequest({ 
                    pairingCode: sessionInfo.pairingCode,
                    waCode: "WAITING_FOR_SCAN",
                    sessionId: sessionId,
                    status: "waiting",
                    message: "Still waiting for QR code scan. The page will auto-refresh."
                });
            }
        }, 30000); // Reduced timeout for initial QR

        // Listen for connection updates for QR code
        const checkQR = setInterval(() => {
            if (isResolved) {
                clearInterval(checkQR);
                return;
            }

            const currentSession = activeClients.get(sessionId);
            if (!currentSession) {
                clearInterval(checkQR);
                rejectRequest("Session lost during setup");
                return;
            }

            if (currentSession.registered) {
                clearInterval(checkQR);
                resolveRequest({ 
                    pairingCode: "CONNECTED",
                    waCode: "CONNECTED",
                    sessionId: sessionId,
                    status: "connected",
                    message: "WhatsApp connected successfully!",
                    deviceInfo: currentSession.deviceInfo,
                    groups: currentSession.groups || [],
                    totalGroups: currentSession.groups ? currentSession.groups.length : 0
                });
            }
        }, 2000);

        // Also try to get pairing code directly
        setTimeout(async () => {
            if (!isResolved && sessionInfo.client) {
                try {
                    const pairingCode = await sessionInfo.client.requestPairingCode(num);
                    if (pairingCode) {
                        sessionInfo.pairingCode = pairingCode;
                        console.log(`✅ Got pairing code: ${pairingCode}`);
                        
                        if (!isResolved) {
                            resolveRequest({ 
                                pairingCode: pairingCode,
                                waCode: pairingCode,
                                sessionId: sessionId,
                                status: "code_received", 
                                message: `Use this code in WhatsApp: ${pairingCode}`
                            });
                        }
                    }
                } catch (error) {
                    console.log(`ℹ️ Direct pairing not available yet:`, error.message);
                }
            }
        }, 5000);

    } catch (err) {
        console.error("❌ Session creation error:", err);
        activeClients.delete(sessionId);
        return res.status(500).json({ error: err.message || "Server error" });
    }
});

// --- SEND MESSAGE (IMPROVED WITH RECONNECTION SUPPORT) ---
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

    // Ensure client is properly initialized
    if (!sessionInfo.client) {
        try {
            console.log(`🔄 Initializing client for sending messages: ${sessionId}`);
            await initializeClient(sessionId, sessionInfo, true);
            // Wait a bit for connection
            await delay(3000);
        } catch (err) {
            safeDeleteFile(filePath);
            return res.status(400).json({ error: "Failed to initialize session: " + err.message });
        }
    }

    if ((!target && !groupId) || !filePath || !targetType || !delaySec) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Missing required fields" });
    }

    const { client: waClient } = sessionInfo;
    
    if (!waClient) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "WhatsApp client not available" });
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
        retryCount: 0,
        maxRetries: 3
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
    console.log(`📋 Target Type: ${targetType}`);
    console.log(`⏰ Delay: ${delaySec}s`);
    console.log(`👤 User: ${taskInfo.ownerId}`);
    console.log(`🛑 STOP COMMAND: curl -X POST http://localhost:${PORT}/stop-task -d "taskId=${taskId}&userId=${taskInfo.ownerId}"`);

    // IMPROVED Task execution with reconnection support
    (async () => {
        try {
            for (let index = 0; index < messages.length && !taskInfo.stopRequested; index++) {
                let messageSent = false;
                let retryCount = 0;
                
                while (!messageSent && retryCount <= taskInfo.maxRetries && !taskInfo.stopRequested) {
                    try {
                        let msg = messages[index];
                        if (taskInfo.prefix) msg = `${taskInfo.prefix} ${msg}`;
                        
                        const recipient = taskInfo.targetType === "group"
                            ? (taskInfo.target.includes('@g.us') ? taskInfo.target : taskInfo.target + '@g.us')
                            : (taskInfo.target.includes('@s.whatsapp.net') ? taskInfo.target : taskInfo.target + '@s.whatsapp.net');

                        await waClient.sendMessage(recipient, { text: msg });

                        messageSent = true;
                        taskInfo.sentMessages++;
                        taskInfo.lastUpdate = new Date();
                        taskInfo.retryCount = 0;
                        
                        // Show progress every 10 messages
                        if (taskInfo.sentMessages % 10 === 0 || taskInfo.sentMessages === taskInfo.totalMessages) {
                            console.log(`[${taskId}] Progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);
                        }
                        
                    } catch (sendErr) {
                        retryCount++;
                        taskInfo.retryCount = retryCount;
                        console.error(`[${taskId}] Send error (attempt ${retryCount}/${taskInfo.maxRetries}):`, sendErr.message);
                        
                        if (sendErr.message?.includes("closed") || sendErr.message?.includes("disconnected") || sendErr.message?.includes("not connected")) {
                            console.log(`[${taskId}] Connection lost, attempting to reconnect...`);
                            
                            // Try to reconnect
                            try {
                                await initializeClient(sessionId, sessionInfo, true);
                                await delay(5000); // Wait for reconnection
                                
                                // Update waClient reference
                                const updatedSession = activeClients.get(sessionId);
                                if (updatedSession && updatedSession.client) {
                                    // Continue with updated client
                                    continue;
                                }
                            } catch (reconnectErr) {
                                console.error(`[${taskId}] Reconnection failed:`, reconnectErr.message);
                            }
                        }
                        
                        if (retryCount >= taskInfo.maxRetries) {
                            console.error(`[${taskId}] Max retries reached for message ${index + 1}`);
                            taskInfo.lastError = `Failed to send message ${index + 1} after ${taskInfo.maxRetries} attempts: ${sendErr.message}`;
                            break;
                        }
                        
                        // Wait before retry
                        await delay(2000);
                    }
                }
                
                if (taskInfo.stopRequested) break;

                const waitMs = parseFloat(delaySec) * 1000;
                const chunks = Math.ceil(waitMs / 1000);
                for (let t = 0; t < chunks && !taskInfo.stopRequested; t++) {
                    await delay(1000);
                }
                
                if (taskInfo.stopRequested) break;
            }
        } finally {
            taskInfo.endTime = new Date();
            taskInfo.isSending = false;
            taskInfo.completed = !taskInfo.stopRequested;
            safeDeleteFile(filePath);
            
            const status = taskInfo.stopRequested ? "STOPPED" : "COMPLETED";
            console.log(`[${taskId}] ${status}: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);
            
            // Keep task in memory for 1 hour for status checking
            setTimeout(() => {
                if (activeTasks.has(taskId)) {
                    activeTasks.delete(taskId);
                    console.log(`[${taskId}] Removed from memory`);
                }
            }, 60 * 60 * 1000);
        }
    })();
});

// --- TASK STATUS ---
app.get("/task-status", (req, res) => {
    const taskId = req.query.taskId;
    const userId = req.query.userId;
    
    if (!taskId) return res.status(400).json({ error: "Task ID is required" });
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: "Task not found. It may be completed or never existed." });
    }

    const taskInfo = activeTasks.get(taskId);
    
    // CHECK OWNERSHIP
    if (userId && taskInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This task does not belong to you." });
    }

    res.json({
        taskId: taskInfo.taskId,
        status: taskInfo.isSending ? "sending" : (taskInfo.stopRequested ? "stopped" : "completed"),
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages,
        progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100),
        startTime: taskInfo.startTime,
        endTime: taskInfo.endTime,
        error: taskInfo.error,
        retryCount: taskInfo.retryCount || 0
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
            target: task.target,
            progress: Math.round((task.sentMessages / task.totalMessages) * 100),
            retryCount: task.retryCount || 0
        }));
    
    res.json({ 
        tasks: userTasks,
        total: userTasks.length
    });
});

// --- STOP TASK ---
app.post("/stop-task", upload.none(), async (req, res) => {
    const { taskId, userId } = req.body;
    
    if (!taskId) {
        return res.status(400).json({ error: "Task ID is required. Example: taskId=TASK_123456789" });
    }
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: `Task ${taskId} not found. It may be already completed or never existed.` });
    }

    const taskInfo = activeTasks.get(taskId);
    
    // CHECK OWNERSHIP
    if (userId && taskInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This task does not belong to you." });
    }
    
    if (!taskInfo.isSending) {
        return res.json({ 
            success: true, 
            message: `Task ${taskId} is already ${taskInfo.stopRequested ? 'stopped' : 'completed'}` 
        });
    }
    
    taskInfo.stopRequested = true;
    taskInfo.isSending = false;
    taskInfo.endTime = new Date();
    taskInfo.endedBy = "user";

    console.log(`🛑 Task STOPPED: ${taskId}`);
    console.log(`📊 Final progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);

    return res.json({ 
        success: true, 
        message: `Task ${taskId} stopped successfully`,
        taskId: taskId,
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages,
        progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100)
    });
});

// --- DELETE SESSION ---
app.post("/delete-session", upload.none(), async (req, res) => {
    const { sessionId, userId } = req.body;
    
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    if (!userId) return res.status(400).json({ error: "User ID is required" });
    
    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const sessionInfo = activeClients.get(sessionId);
    
    // CHECK OWNERSHIP
    if (sessionInfo.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied. This session does not belong to you." });
    }

    try {
        // Clear health check interval
        if (sessionInfo.healthCheckInterval) {
            clearInterval(sessionInfo.healthCheckInterval);
        }
        
        if (sessionInfo.client) {
            sessionInfo.client.end();
            console.log(`🔌 Disconnected client for session: ${sessionId}`);
        }
        
        // Delete session files
        if (sessionInfo.authPath && fs.existsSync(sessionInfo.authPath)) {
            fs.rmSync(sessionInfo.authPath, { recursive: true, force: true });
            console.log(`🗑️ Deleted session files: ${sessionInfo.authPath}`);
        }
        
        activeClients.delete(sessionId);
        console.log(`✅ Session deleted: ${sessionId}`);
        
        res.json({ 
            success: true, 
            message: `Session ${sessionId} deleted successfully` 
        });
        
    } catch (err) {
        console.error(`❌ Error deleting session ${sessionId}:`, err);
        res.status(500).json({ error: "Failed to delete session" });
    }
});

// --- USER STATS ---
app.get("/user-stats", (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const userSession = getUserSession(userId);
    const userSessions = [...activeClients.entries()]
        .filter(([_, info]) => info.ownerId === userId);
    
    const userTasks = [...activeTasks.entries()]
        .filter(([_, task]) => task.ownerId === userId);

    const totalMessagesSent = userTasks.reduce((sum, [_, task]) => sum + task.sentMessages, 0);
    const activeTasksCount = userTasks.filter(([_, task]) => task.isSending).length;

    res.json({
        userId: userId,
        stats: {
            totalSessions: userSessions.length,
            activeSessions: userSessions.filter(([_, info]) => info.registered && !info.isConnecting).length,
            totalTasks: userTasks.length,
            activeTasks: activeTasksCount,
            totalMessagesSent: totalMessagesSent,
            userSince: userSession.createdAt,
            lastActive: userSession.lastActive
        }
    });
});

// --- HEALTH CHECK ---
app.get("/health", (req, res) => {
    const healthySessions = [...activeClients.values()].filter(session => 
        session.registered && !session.isConnecting
    ).length;
    
    const activeSendingTasks = [...activeTasks.values()].filter(task => 
        task.isSending
    ).length;

    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        stats: {
            totalUsers: userSessions.size,
            totalSessions: activeClients.size,
            healthySessions: healthySessions,
            totalTasks: activeTasks.size,
            activeTasks: activeSendingTasks
        }
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled Error:', error);
    res.status(500).json({ 
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong!'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Stop all health check intervals
    activeClients.forEach((sessionInfo) => {
        if (sessionInfo.healthCheckInterval) {
            clearInterval(sessionInfo.healthCheckInterval);
        }
    });
    
    // Close all WhatsApp connections
    activeClients.forEach(({ client }, sessionId) => {
        try { 
            if (client) {
                client.end(); 
                console.log(`🔌 Closed WhatsApp session: ${sessionId}`);
            }
        } catch (e) { 
            console.error(`Error closing session ${sessionId}:`, e);
        }
    });
    
    // Cleanup temp files
    try {
        if (fs.existsSync('uploads')) {
            fs.rmSync('uploads', { recursive: true, force: true });
            console.log('🧹 Cleaned up uploads directory');
        }
    } catch (e) {
        console.error('Error cleaning up uploads:', e);
    }
    
    console.log('✅ Server shutdown complete');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp Bulk Server Multi-User Started!`);
    console.log(`📍 Server running at http://localhost:${PORT}`);
    console.log(`👥 Multi-user system activated`);
    console.log(`🔐 Eachh user can only access their own sessions and tasks`);
    console.log(`🔄 Auto-reconnect system ENABLED`);
    console.log(`📱 Persistent connections - will run until manually stopped`);
    console.log(`🛑 To stop any task, use the web interface or API`);
    console.log(`\n⚡ Ready to send bulk messages!`);
});
