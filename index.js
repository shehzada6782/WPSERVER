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
    makeWASocket
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

// Create necessary directories
if (!fs.existsSync("temp")) fs.mkdirSync("temp", { recursive: true });
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });
if (!fs.existsSync("public")) fs.mkdirSync("public", { recursive: true });

// Configure multer for file uploads
const upload = multer({ 
    dest: "uploads/",
    limits: {
        fileSize: 10 * 1024 * 1024,
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Store active sessions and tasks
const activeClients = new Map();
const activeTasks = new Map();

// Utility functions
function safeDeleteFile(filePath) {
    try { 
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath); 
        }
    } catch (e) { 
        console.log("File delete error:", e.message);
    }
}

function generateSessionId() {
    return "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

// Pair new WhatsApp number
app.get("/pair", async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        return res.status(400).json({ error: "Phone number is required" });
    }

    const sessionId = generateSessionId();
    const sessionPath = path.join("temp", sessionId);

    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const waSocket = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: true,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu("Chrome"),
        });

        let qrReceived = false;

        waSocket.ev.on("creds.update", saveCreds);
        
        waSocket.ev.on("connection.update", (update) => {
            const { connection, qr } = update;
            
            if (qr && !qrReceived) {
                qrReceived = true;
                
                activeClients.set(sessionId, {
                    socket: waSocket,
                    number: number,
                    qrCode: qr,
                    connected: false,
                    sessionPath: sessionPath
                });

                res.json({
                    success: true,
                    qrCode: qr,
                    sessionId: sessionId,
                    message: "Scan QR code with WhatsApp"
                });
            }
            
            if (connection === "open") {
                console.log("WhatsApp connected for session:", sessionId);
                const session = activeClients.get(sessionId);
                if (session) {
                    session.connected = true;
                }
            }
        });

        // Timeout after 2 minutes
        setTimeout(() => {
            if (!qrReceived) {
                if (!res.headersSent) {
                    res.status(408).json({ error: "QR code timeout" });
                }
            }
        }, 120000);

    } catch (error) {
        console.error("Pairing error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Send message endpoint
app.post("/send", upload.single("messageFile"), async (req, res) => {
    const { sessionId, target, message, delaySec = "2" } = req.body;
    const filePath = req.file?.path;

    if (!sessionId || !target) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Session ID and target are required" });
    }

    const session = activeClients.get(sessionId);
    if (!session || !session.connected) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Session not connected" });
    }

    let messages = [];
    if (filePath) {
        try {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            messages = fileContent.split("\n").filter(line => line.trim());
        } catch (error) {
            safeDeleteFile(filePath);
            return res.status(400).json({ error: "Invalid message file" });
        }
    } else if (message) {
        messages = [message];
    } else {
        return res.status(400).json({ error: "No message provided" });
    }

    const taskId = "task_" + Date.now();
    const taskInfo = {
        taskId: taskId,
        sessionId: sessionId,
        isSending: true,
        stopRequested: false,
        totalMessages: messages.length,
        sentMessages: 0,
        target: target,
        startTime: new Date()
    };

    activeTasks.set(taskId, taskInfo);

    // Send response immediately
    res.json({
        success: true,
        taskId: taskId,
        message: `Started sending ${messages.length} messages`
    });

    // Send messages in background
    (async () => {
        try {
            for (let i = 0; i < messages.length; i++) {
                if (taskInfo.stopRequested) break;

                try {
                    const jid = target.includes('@g.us') ? target : target + '@s.whatsapp.net';
                    await session.socket.sendMessage(jid, { text: messages[i] });
                    taskInfo.sentMessages++;
                } catch (sendError) {
                    console.error("Send error:", sendError);
                }

                // Delay between messages
                if (i < messages.length - 1 && !taskInfo.stopRequested) {
                    await delay(parseFloat(delaySec) * 1000);
                }
            }
        } catch (error) {
            console.error("Task error:", error);
        } finally {
            taskInfo.isSending = false;
            taskInfo.endTime = new Date();
            safeDeleteFile(filePath);
        }
    })();
});

// Stop task endpoint
app.post("/stop-task", (req, res) => {
    const { taskId } = req.body;
    
    if (!taskId) {
        return res.status(400).json({ error: "Task ID is required" });
    }

    const task = activeTasks.get(taskId);
    if (!task) {
        return res.status(404).json({ error: "Task not found" });
    }

    task.stopRequested = true;
    res.json({ success: true, message: "Task stopped" });
});

// Get task status
app.get("/task-status", (req, res) => {
    const { taskId } = req.query;
    
    if (!taskId) {
        return res.status(400).json({ error: "Task ID is required" });
    }

    const task = activeTasks.get(taskId);
    if (!task) {
        return res.status(404).json({ error: "Task not found" });
    }

    res.json({
        taskId: task.taskId,
        status: task.isSending ? "sending" : "completed",
        sentMessages: task.sentMessages,
        totalMessages: task.totalMessages,
        progress: Math.round((task.sentMessages / task.totalMessages) * 100)
    });
});

// Get active sessions
app.get("/sessions", (req, res) => {
    const sessions = Array.from(activeClients.entries()).map(([id, session]) => ({
        sessionId: id,
        number: session.number,
        connected: session.connected,
        hasQR: !!session.qrCode
    }));

    res.json({ sessions });
});

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        sessions: activeClients.size,
        tasks: activeTasks.size
    });
});

// Cleanup on exit
process.on('SIGINT', () => {
    console.log("Shutting down...");
    
    activeClients.forEach((session) => {
        try {
            if (session.socket) {
                session.socket.end();
            }
        } catch (error) {
            console.error("Error closing session:", error);
        }
    });
    
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`WhatsApp Bulk Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to access the application`);
});
