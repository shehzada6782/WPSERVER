// Multi-User WhatsApp Bulk Sender - Frontend JavaScript
class WhatsAppBulkSender {
    constructor() {
        this.userId = null;
        this.userSessions = [];
        this.userTasks = [];
        this.userStats = {};
        this.currentSection = 'dashboard';
        this.baseUrl = window.location.origin;
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.checkStoredUser();
        this.setupNavigation();
    }

    setupEventListeners() {
        // User setup
        document.getElementById('startSessionBtn').addEventListener('click', () => this.startUserSession());
        document.getElementById('userIdInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.startUserSession();
        });

        // Pairing
        document.getElementById('startPairing').addEventListener('click', () => this.startPairing());
        
        // Message sending
        document.getElementById('messageForm').addEventListener('submit', (e) => this.sendMessages(e));
        document.getElementById('messageFile').addEventListener('change', (e) => this.previewMessageFile(e));
        document.getElementById('delaySec').addEventListener('change', () => this.updateEstimatedTime());
        document.getElementById('targetType').addEventListener('change', () => this.updateTargetOptions());
        document.getElementById('targetSelect').addEventListener('change', () => this.handleTargetSelection());
        document.getElementById('sessionSelect').addEventListener('change', () => this.updateSessionInfo());

        // Auto-load user data when modal closes
        document.getElementById('pairModal').addEventListener('hidden.bs.modal', () => {
            if (this.userId) this.loadUserData();
        });
    }

    checkStoredUser() {
        const storedUser = localStorage.getItem('whatsappUser');
        if (storedUser) {
            this.userId = storedUser;
            this.initializeUserInterface();
        } else {
            this.showUserSetup();
        }
    }

    showUserSetup() {
        const modal = new bootstrap.Modal(document.getElementById('userSetupModal'));
        modal.show();
    }

    startUserSession() {
        const userIdInput = document.getElementById('userIdInput').value.trim();
        if (!userIdInput) {
            this.showAlert('Please enter a User ID', 'warning');
            return;
        }

        // Basic validation
        if (userIdInput.length < 3) {
            this.showAlert('User ID must be at least 3 characters long', 'warning');
            return;
        }

        this.userId = userIdInput.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        localStorage.setItem('whatsappUser', this.userId);
        
        const modal = bootstrap.Modal.getInstance(document.getElementById('userSetupModal'));
        modal.hide();
        
        this.initializeUserInterface();
    }

    initializeUserInterface() {
        document.getElementById('currentUserId').textContent = `User: ${this.userId}`;
        document.getElementById('userDisplayId').textContent = this.userId;
        document.getElementById('userAvatar').textContent = this.userId.charAt(0).toUpperCase();
        document.getElementById('pairUserId').value = this.userId;
        document.getElementById('analyticsUserId').textContent = this.userId;

        this.loadUserData();
        this.startAutoRefresh();
    }

    async loadUserData() {
        if (!this.userId) return;

        try {
            await Promise.all([
                this.loadUserSessions(),
                this.loadUserTasks(),
                this.loadUserStats()
            ]);
            
            this.updateUI();
        } catch (error) {
            console.error('Error loading user data:', error);
            this.showAlert('Failed to load user data', 'danger');
        }
    }

    async loadUserSessions() {
        const response = await fetch(`${this.baseUrl}/user-sessions?userId=${this.userId}`);
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }

        this.userSessions = data.sessions || [];
        this.updateSessionsDropdown();
    }

    async loadUserTasks() {
        const response = await fetch(`${this.baseUrl}/user-tasks?userId=${this.userId}`);
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }

        this.userTasks = data.tasks || [];
    }

    async loadUserStats() {
        const response = await fetch(`${this.baseUrl}/user-stats?userId=${this.userId}`);
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }

        this.userStats = data.stats || {};
        document.getElementById('userSince').textContent = new Date(data.stats.userSince).toLocaleDateString();
    }

    updateUI() {
        this.updateStatsCards();
        this.updateSessionsList();
        this.updateTasksList();
        this.updateUserStats();
    }

    updateStatsCards() {
        const stats = this.userStats;
        const statsContainer = document.getElementById('statsContainer');
        
        const statsHTML = `
            <div class="col-xl-3 col-md-6 mb-4">
                <div class="card stat-card">
                    <div class="card-body">
                        <i class="fas fa-mobile-alt"></i>
                        <div class="number">${stats.totalSessions || 0}</div>
                        <div class="label">Total Sessions</div>
                    </div>
                </div>
            </div>
            <div class="col-xl-3 col-md-6 mb-4">
                <div class="card stat-card">
                    <div class="card-body">
                        <i class="fas fa-users"></i>
                        <div class="number">${this.getTotalGroups()}</div>
                        <div class="label">Total Groups</div>
                    </div>
                </div>
            </div>
            <div class="col-xl-3 col-md-6 mb-4">
                <div class="card stat-card">
                    <div class="card-body">
                        <i class="fas fa-paper-plane"></i>
                        <div class="number">${stats.totalMessagesSent || 0}</div>
                        <div class="label">Messages Sent</div>
                    </div>
                </div>
            </div>
            <div class="col-xl-3 col-md-6 mb-4">
                <div class="card stat-card">
                    <div class="card-body">
                        <i class="fas fa-tasks"></i>
                        <div class="number">${stats.activeTasks || 0}</div>
                        <div class="label">Active Tasks</div>
                    </div>
                </div>
            </div>
        `;
        
        statsContainer.innerHTML = statsHTML;
        document.getElementById('userStats').textContent = `${stats.totalSessions || 0} sessions, ${stats.activeTasks || 0} tasks`;
    }

    getTotalGroups() {
        return this.userSessions.reduce((total, session) => total + (session.totalGroups || 0), 0);
    }

    updateSessionsList() {
        const sessionsList = document.getElementById('sessionsList');
        const sessionsContainer = document.getElementById('sessionsContainer');
        
        if (this.userSessions.length === 0) {
            sessionsList.innerHTML = `
                <div class="text-center py-4">
                    <i class="fas fa-mobile-alt fa-3x text-muted mb-3"></i>
                    <p class="text-muted">No WhatsApp sessions paired yet.</p>
                    <button class="btn btn-whatsapp" data-bs-toggle="modal" data-bs-target="#pairModal">
                        <i class="fas fa-plus me-1"></i> Pair Your First Number
                    </button>
                </div>
            `;
            sessionsContainer.innerHTML = '';
            return;
        }

        // Dashboard sessions list
        let sessionsHTML = '';
        this.userSessions.slice(0, 3).forEach(session => {
            sessionsHTML += this.createSessionCardHTML(session);
        });
        sessionsList.innerHTML = sessionsHTML;

        // Full sessions page
        let fullSessionsHTML = '';
        this.userSessions.forEach(session => {
            fullSessionsHTML += `
                <div class="col-md-6 col-lg-4 mb-4">
                    <div class="card session-card h-100">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-start mb-3">
                                <h5 class="card-title">${session.number}</h5>
                                <span class="badge ${session.registered ? 'badge-connected' : 'badge-connecting'}">
                                    ${session.registered ? 'Connected' : 'Connecting'}
                                </span>
                            </div>
                            <p class="card-text">
                                <i class="fas fa-users me-2"></i> ${session.totalGroups} Groups
                                <br>
                                <i class="fas fa-clock me-2"></i> ${this.formatTime(session.pairedAt)}
                            </p>
                            <div class="device-info mb-3">
                                <small>${session.deviceInfo ? `Device: ${session.deviceInfo.platform}` : 'Waiting for connection...'}</small>
                            </div>
                            <div class="btn-group w-100">
                                <button class="btn btn-outline-primary btn-sm" onclick="app.viewSessionGroups('${session.sessionId}')">
                                    <i class="fas fa-eye me-1"></i> Groups
                                </button>
                                <button class="btn btn-outline-info btn-sm" onclick="app.refreshSessionGroups('${session.sessionId}')">
                                    <i class="fas fa-sync me-1"></i> Refresh
                                </button>
                                <button class="btn btn-outline-danger btn-sm" onclick="app.deleteSession('${session.sessionId}')">
                                    <i class="fas fa-trash me-1"></i> Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });
        sessionsContainer.innerHTML = fullSessionsHTML;
    }

    createSessionCardHTML(session) {
        return `
            <div class="session-item card mb-3">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <h6 class="mb-1">${session.number}</h6>
                            <small class="text-muted">${session.totalGroups} groups • ${this.formatTime(session.pairedAt)}</small>
                        </div>
                        <span class="badge ${session.registered ? 'badge-connected' : 'badge-connecting'}">
                            ${session.registered ? 'Connected' : 'Connecting'}
                        </span>
                    </div>
                </div>
            </div>
        `;
    }

    updateTasksList() {
        const activeTasksList = document.getElementById('activeTasksList');
        const tasksTableBody = document.getElementById('tasksTableBody');
        
        // Active tasks widget
        const activeTasks = this.userTasks.filter(task => task.isSending);
        if (activeTasks.length === 0) {
            activeTasksList.innerHTML = '<p class="text-muted text-center">No active tasks</p>';
        } else {
            let activeTasksHTML = '';
            activeTasks.slice(0, 3).forEach(task => {
                activeTasksHTML += `
                    <div class="d-flex align-items-center mb-3">
                        <div class="flex-grow-1">
                            <h6 class="mb-0">${task.target}</h6>
                            <small class="text-muted">Session: ${task.sessionId.split('_')[1]}</small>
                        </div>
                        <span class="badge bg-warning">Running</span>
                    </div>
                    <div class="progress mb-2">
                        <div class="progress-bar" role="progressbar" style="width: ${task.progress}%"></div>
                    </div>
                    <small class="text-muted">${task.progress}% completed (${task.sentMessages}/${task.totalMessages} messages)</small>
                    <hr>
                `;
            });
            activeTasksList.innerHTML = activeTasksHTML;
        }

        // Full tasks table
        if (this.userTasks.length === 0) {
            tasksTableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-muted py-4">No tasks found</td>
                </tr>
            `;
        } else {
            let tasksHTML = '';
            this.userTasks.forEach(task => {
                tasksHTML += `
                    <tr>
                        <td><code>${task.taskId}</code></td>
                        <td>${task.sessionId.split('_')[1]}</td>
                        <td>${task.target}</td>
                        <td>
                            <div class="task-progress">
                                <div class="progress">
                                    <div class="progress-bar" role="progressbar" style="width: ${task.progress}%"></div>
                                </div>
                                <small>${task.progress}% (${task.sentMessages}/${task.totalMessages})</small>
                            </div>
                        </td>
                        <td>
                            <span class="badge ${task.isSending ? 'bg-warning' : task.stopRequested ? 'bg-danger' : 'bg-success'}">
                                ${task.isSending ? 'Running' : task.stopRequested ? 'Stopped' : 'Completed'}
                            </span>
                        </td>
                        <td>${new Date(task.startTime).toLocaleString()}</td>
                        <td>
                            ${task.isSending ? `
                                <button class="btn btn-sm btn-outline-danger" onclick="app.stopTask('${task.taskId}')">
                                    <i class="fas fa-stop me-1"></i> Stop
                                </button>
                            ` : `
                                <button class="btn btn-sm btn-outline-info" onclick="app.viewTaskStatus('${task.taskId}')">
                                    <i class="fas fa-info me-1"></i> Details
                                </button>
                            `}
                        </td>
                    </tr>
                `;
            });
            tasksTableBody.innerHTML = tasksHTML;
        }
    }

    updateUserStats() {
        const analyticsContent = document.getElementById('analyticsContent');
        const stats = this.userStats;
        
        analyticsContent.innerHTML = `
            <div class="row">
                <div class="col-md-6 mb-4">
                    <div class="card stat-card">
                        <div class="card-body">
                            <i class="fas fa-chart-line"></i>
                            <div class="number">${stats.totalMessagesSent || 0}</div>
                            <div class="label">Total Messages Sent</div>
                        </div>
                    </div>
                </div>
                <div class="col-md-6 mb-4">
                    <div class="card stat-card">
                        <div class="card-body">
                            <i class="fas fa-check-circle"></i>
                            <div class="number">${stats.totalTasks || 0}</div>
                            <div class="label">Completed Tasks</div>
                        </div>
                    </div>
                </div>
                <div class="col-md-6 mb-4">
                    <div class="card stat-card">
                        <div class="card-body">
                            <i class="fas fa-mobile-alt"></i>
                            <div class="number">${stats.totalSessions || 0}</div>
                            <div class="label">Paired Sessions</div>
                        </div>
                    </div>
                </div>
                <div class="col-md-6 mb-4">
                    <div class="card stat-card">
                        <div class="card-body">
                            <i class="fas fa-clock"></i>
                            <div class="number">${stats.activeTasks || 0}</div>
                            <div class="label">Active Tasks</div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="mt-4">
                <h5>Session Activity</h5>
                <p class="text-muted">Last active: ${new Date(stats.lastActive).toLocaleString()}</p>
                <p class="text-muted">User since: ${new Date(stats.userSince).toLocaleDateString()}</p>
            </div>
        `;
    }

    updateSessionsDropdown() {
        const sessionSelect = document.getElementById('sessionSelect');
        sessionSelect.innerHTML = '<option value="">Choose a session...</option>';
        
        this.userSessions.forEach(session => {
            if (session.registered && !session.isConnecting) {
                const option = document.createElement('option');
                option.value = session.sessionId;
                option.textContent = `${session.number} (${session.totalGroups} groups)`;
                sessionSelect.appendChild(option);
            }
        });
    }

    async startPairing() {
        const phoneNumber = document.getElementById('phoneNumber').value.trim();
        if (!phoneNumber) {
            this.showAlert('Please enter a phone number', 'warning');
            return;
        }

        document.getElementById('pairingResult').classList.remove('d-none');
        document.getElementById('startPairing').disabled = true;

        try {
            const response = await fetch(`${this.baseUrl}/code?number=${phoneNumber}&userId=${this.userId}`);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            document.getElementById('pairingCode').textContent = data.pairingCode;
            document.getElementById('pairingStatus').textContent = data.message;

            if (data.status === 'connected' || data.status === 'already-registered') {
                setTimeout(() => {
                    const modal = bootstrap.Modal.getInstance(document.getElementById('pairModal'));
                    modal.hide();
                    this.resetPairingModal();
                    this.loadUserData();
                }, 2000);
            } else {
                // Poll for connection status
                this.pollConnectionStatus(data.sessionId);
            }
        } catch (error) {
            this.showAlert(error.message, 'danger');
            this.resetPairingModal();
        }
    }

    async pollConnectionStatus(sessionId) {
        const maxAttempts = 60; // 5 minutes
        let attempts = 0;

        const checkStatus = async () => {
            try {
                const response = await fetch(`${this.baseUrl}/user-sessions?userId=${this.userId}`);
                const data = await response.json();
                
                const session = data.sessions.find(s => s.sessionId === sessionId);
                if (session && session.registered) {
                    document.getElementById('pairingStatus').textContent = 'Connected successfully!';
                    document.querySelector('.progress-bar').classList.remove('progress-bar-animated');
                    document.querySelector('.progress-bar').classList.add('bg-success');
                    
                    setTimeout(() => {
                        const modal = bootstrap.Modal.getInstance(document.getElementById('pairModal'));
                        modal.hide();
                        this.resetPairingModal();
                        this.loadUserData();
                    }, 2000);
                    return;
                }
                
                attempts++;
                if (attempts >= maxAttempts) {
                    document.getElementById('pairingStatus').textContent = 'Connection timeout. Please try again.';
                    document.querySelector('.progress-bar').classList.remove('progress-bar-animated');
                    document.querySelector('.progress-bar').classList.add('bg-danger');
                    setTimeout(() => this.resetPairingModal(), 3000);
                    return;
                }
                
                setTimeout(checkStatus, 5000); // Check every 5 seconds
            } catch (error) {
                console.error('Error checking connection status:', error);
                setTimeout(checkStatus, 5000);
            }
        };

        checkStatus();
    }

    resetPairingModal() {
        document.getElementById('pairForm').reset();
        document.getElementById('pairingResult').classList.add('d-none');
        document.getElementById('startPairing').disabled = false;
        document.querySelector('.progress-bar').classList.remove('bg-success', 'bg-danger');
        document.querySelector('.progress-bar').classList.add('progress-bar-animated');
    }

    async sendMessages(e) {
        e.preventDefault();
        
        const sessionId = document.getElementById('sessionSelect').value;
        const targetType = document.getElementById('targetType').value;
        const delaySec = document.getElementById('delaySec').value;
        const prefix = document.getElementById('prefix').value;
        const messageFile = document.getElementById('messageFile').files[0];
        
        let target = '';
        if (targetType === 'group') {
            const groupSelect = document.getElementById('groupSelect');
            const manualTarget = document.getElementById('manualTarget');
            target = groupSelect.value && groupSelect.value !== '' ? groupSelect.value : manualTarget.value;
        } else {
            target = document.getElementById('manualTarget').value;
        }

        if (!sessionId || !target || !messageFile) {
            this.showAlert('Please fill all required fields', 'warning');
            return;
        }

        const formData = new FormData();
        formData.append('sessionId', sessionId);
        formData.append('target', target);
        formData.append('targetType', targetType);
        formData.append('delaySec', delaySec);
        formData.append('prefix', prefix);
        formData.append('userId', this.userId);
        formData.append('messageFile', messageFile);

        try {
            const response = await fetch(`${this.baseUrl}/send-message`, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            this.showAlert(`Task started! Task ID: ${data.taskId}`, 'success');
            document.getElementById('messageForm').reset();
            document.getElementById('previewMessage').value = '';
            document.getElementById('totalMessages').textContent = '0';
            document.getElementById('estimatedTime').textContent = '0 min';
            
            // Refresh tasks list
            setTimeout(() => this.loadUserTasks(), 1000);
        } catch (error) {
            this.showAlert(error.message, 'danger');
        }
    }

    previewMessageFile(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const content = e.target.result;
                const lines = content.split('\n').filter(line => line.trim() !== '');
                document.getElementById('previewMessage').value = lines[0] || 'No messages found';
                document.getElementById('totalMessages').textContent = lines.length;
                this.updateEstimatedTime();
            };
            reader.readAsText(file);
        }
    }

    updateEstimatedTime() {
        const totalMessages = parseInt(document.getElementById('totalMessages').textContent) || 0;
        const delay = parseInt(document.getElementById('delaySec').value) || 2;
        const totalTime = totalMessages * delay;
        const minutes = Math.floor(totalTime / 60);
        document.getElementById('estimatedTime').textContent = `${minutes} min`;
        document.getElementById('displayDelay').textContent = delay;
    }

    updateTargetOptions() {
        const targetType = document.getElementById('targetType').value;
        const manualInput = document.getElementById('manualTargetInput');
        const groupList = document.getElementById('groupListContainer');
        
        if (targetType === 'group') {
            manualInput.classList.add('d-none');
            groupList.classList.remove('d-none');
        } else {
            manualInput.classList.remove('d-none');
            groupList.classList.add('d-none');
        }
        
        document.getElementById('targetSelect').value = '';
        this.handleTargetSelection();
    }

    handleTargetSelection() {
        const targetSelect = document.getElementById('targetSelect').value;
        const manualInput = document.getElementById('manualTargetInput');
        const groupList = document.getElementById('groupListContainer');
        
        if (targetSelect === 'manual') {
            manualInput.classList.remove('d-none');
            groupList.classList.add('d-none');
            document.getElementById('targetInfo').textContent = 'Manual entry';
            document.getElementById('targetDetails').textContent = 'Type: Individual';
        } else if (targetSelect === 'group_list') {
            manualInput.classList.add('d-none');
            groupList.classList.remove('d-none');
            this.loadGroupsForSelectedSession();
        } else {
            manualInput.classList.add('d-none');
            groupList.classList.add('d-none');
            document.getElementById('targetInfo').textContent = 'Not selected';
            document.getElementById('targetDetails').textContent = 'Type: Not set';
        }
    }

    async loadGroupsForSelectedSession() {
        const sessionId = document.getElementById('sessionSelect').value;
        if (!sessionId) return;

        try {
            const response = await fetch(`${this.baseUrl}/groups?sessionId=${sessionId}&userId=${this.userId}`);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            const groupSelect = document.getElementById('groupSelect');
            groupSelect.innerHTML = '<option value="">Select a group...</option>';
            
            data.groups.forEach(group => {
                const option = document.createElement('option');
                option.value = group.id;
                option.textContent = `${group.name} (${group.participants} members)`;
                groupSelect.appendChild(option);
            });

            groupSelect.addEventListener('change', () => {
                const selectedGroup = groupSelect.options[groupSelect.selectedIndex];
                if (selectedGroup.value) {
                    document.getElementById('targetInfo').textContent = selectedGroup.text;
                    document.getElementById('targetDetails').textContent = 'Type: Group';
                }
            });
        } catch (error) {
            this.showAlert('Failed to load groups: ' + error.message, 'danger');
        }
    }

    updateSessionInfo() {
        const sessionId = document.getElementById('sessionSelect').value;
        const session = this.userSessions.find(s => s.sessionId === sessionId);
        
        if (session) {
            document.getElementById('selectedSessionInfo').textContent = session.number;
            document.getElementById('sessionStatus').textContent = `Status: ${session.registered ? 'Connected' : 'Connecting'}`;
            
            // Reload groups if group list is visible
            if (document.getElementById('groupListContainer').classList.contains('d-none') === false) {
                this.loadGroupsForSelectedSession();
            }
        } else {
            document.getElementById('selectedSessionInfo').textContent = 'Not selected';
            document.getElementById('sessionStatus').textContent = 'Status: Unknown';
        }
    }

    async viewSessionGroups(sessionId) {
        const session = this.userSessions.find(s => s.sessionId === sessionId);
        if (!session) return;

        try {
            const response = await fetch(`${this.baseUrl}/groups?sessionId=${sessionId}&userId=${this.userId}`);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            let groupsHTML = '<h5>Groups for ' + session.number + '</h5>';
            data.groups.forEach(group => {
                groupsHTML += `
                    <div class="card group-card mb-2">
                        <div class="card-body py-2">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <h6 class="mb-0">${group.name}</h6>
                                    <small class="text-muted">${group.participants} members</small>
                                </div>
                                <span class="badge ${group.isAnnouncement ? 'bg-info' : 'bg-secondary'}">
                                    ${group.isAnnouncement ? 'Announcement' : 'Group'}
                                </span>
                            </div>
                        </div>
                    </div>
                `;
            });

            this.showAlert(groupsHTML, 'info', 10000);
        } catch (error) {
            this.showAlert('Failed to load groups: ' + error.message, 'danger');
        }
    }

    async refreshSessionGroups(sessionId) {
        try {
            const response = await fetch(`${this.baseUrl}/refresh-groups`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `sessionId=${sessionId}&userId=${this.userId}`
            });
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            this.showAlert(`Refreshed ${data.total} groups successfully`, 'success');
            this.loadUserData();
        } catch (error) {
            this.showAlert('Failed to refresh groups: ' + error.message, 'danger');
        }
    }

    async refreshAllGroups() {
        for (const session of this.userSessions) {
            if (session.registered) {
                await this.refreshSessionGroups(session.sessionId);
            }
        }
    }

    async deleteSession(sessionId) {
        if (!confirm('Are you sure you want to delete this session? This will remove the WhatsApp connection.')) {
            return;
        }

        try {
            const response = await fetch(`${this.baseUrl}/delete-session`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `sessionId=${sessionId}&userId=${this.userId}`
            });
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            this.showAlert('Session deleted successfully', 'success');
            this.loadUserData();
        } catch (error) {
            this.showAlert('Failed to delete session: ' + error.message, 'danger');
        }
    }

    async stopTask(taskId) {
        try {
            const response = await fetch(`${this.baseUrl}/stop-task`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `taskId=${taskId}&userId=${this.userId}`
            });
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            this.showAlert('Task stopped successfully', 'success');
            this.loadUserTasks();
        } catch (error) {
            this.showAlert('Failed to stop task: ' + error.message, 'danger');
        }
    }

    async viewTaskStatus(taskId) {
        try {
            const response = await fetch(`${this.baseUrl}/task-status?taskId=${taskId}&userId=${this.userId}`);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            const statusHTML = `
                <h6>Task Details</h6>
                <p><strong>Task ID:</strong> <code>${data.taskId}</code></p>
                <p><strong>Status:</strong> <span class="badge ${data.status === 'sending' ? 'bg-warning' : data.status === 'stopped' ? 'bg-danger' : 'bg-success'}">${data.status}</span></p>
                <p><strong>Progress:</strong> ${data.progress}% (${data.sentMessages}/${data.totalMessages} messages)</p>
                <p><strong>Start Time:</strong> ${new Date(data.startTime).toLocaleString()}</p>
                ${data.endTime ? `<p><strong>End Time:</strong> ${new Date(data.endTime).toLocaleString()}</p>` : ''}
                ${data.error ? `<p><strong>Error:</strong> <span class="text-danger">${data.error}</span></p>` : ''}
            `;

            document.getElementById('taskStatusContent').innerHTML = statusHTML;
            const modal = new bootstrap.Modal(document.getElementById('taskStatusModal'));
            modal.show();
        } catch (error) {
            this.showAlert('Failed to load task status: ' + error.message, 'danger');
        }
    }

    setupNavigation() {
        document.querySelectorAll('.sidebar .nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = link.getAttribute('href').substring(1);
                this.showSection(targetId);
            });
        });
    }

    showSection(sectionId) {
        // Hide all sections
        document.querySelectorAll('section').forEach(section => {
            section.classList.add('d-none');
        });
        
        // Show target section
        document.getElementById(sectionId).classList.remove('d-none');
        
        // Update active nav link
        document.querySelectorAll('.sidebar .nav-link').forEach(link => {
            link.classList.remove('active');
        });
        
        document.querySelector(`.sidebar .nav-link[href="#${sectionId}"]`).classList.add('active');
        
        this.currentSection = sectionId;
        
        // Load section-specific data
        if (sectionId === 'tasks') {
            this.loadUserTasks();
        } else if (sectionId === 'analytics') {
            this.loadUserStats();
        } else if (sectionId === 'groups') {
            this.loadGroupsView();
        }
    }

    async loadGroupsView() {
        const groupsContainer = document.getElementById('groupsContainer');
        
        if (this.userSessions.length === 0) {
            groupsContainer.innerHTML = `
                <div class="col-12 text-center py-5">
                    <i class="fas fa-users fa-4x text-muted mb-3"></i>
                    <h4 class="text-muted">No WhatsApp sessions</h4>
                    <p class="text-muted">Pair a WhatsApp number to see your groups</p>
                    <button class="btn btn-whatsapp" data-bs-toggle="modal" data-bs-target="#pairModal">
                        <i class="fas fa-plus me-1"></i> Pair WhatsApp Number
                    </button>
                </div>
            `;
            return;
        }

        let groupsHTML = '';
        
        for (const session of this.userSessions) {
            if (!session.registered) continue;
            
            try {
                const response = await fetch(`${this.baseUrl}/groups?sessionId=${session.sessionId}&userId=${this.userId}`);
                const data = await response.json();
                
                if (data.error) continue;
                
                groupsHTML += `
                    <div class="col-12 mb-4">
                        <div class="card">
                            <div class="card-header d-flex justify-content-between align-items-center">
                                <span>${session.number} - ${data.groups.length} Groups</span>
                                <button class="btn btn-sm btn-outline-info" onclick="app.refreshSessionGroups('${session.sessionId}')">
                                    <i class="fas fa-sync me-1"></i> Refresh
                                </button>
                            </div>
                            <div class="card-body">
                                <div class="row">
                `;
                
                data.groups.forEach(group => {
                    groupsHTML += `
                        <div class="col-md-6 col-lg-4 mb-3">
                            <div class="card group-card h-100">
                                <div class="card-body">
                                    <div class="d-flex justify-content-between align-items-start mb-2">
                                        <h6 class="card-title">${group.name}</h6>
                                        <span class="badge bg-primary">${group.participants} members</span>
                                    </div>
                                    <p class="card-text small">
                                        <i class="fas fa-bell me-1"></i> ${group.isAnnouncement ? 'Announcements' : 'All messages'}
                                        <br>
                                        <i class="fas fa-lock me-1"></i> ${group.isLocked ? 'Locked' : 'Open'}
                                    </p>
                                    <small class="text-muted">ID: ${group.id}</small>
                                </div>
                            </div>
                        </div>
                    `;
                });
                
                groupsHTML += `
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            } catch (error) {
                console.error('Error loading groups for session:', session.sessionId, error);
            }
        }
        
        groupsContainer.innerHTML = groupsHTML || `
            <div class="col-12 text-center py-5">
                <i class="fas fa-exclamation-triangle fa-3x text-warning mb-3"></i>
                <h4 class="text-warning">Unable to load groups</h4>
                <p class="text-muted">Please check your WhatsApp connections and try again</p>
            </div>
        `;
    }

    startAutoRefresh() {
        // Refresh data every 30 seconds
        setInterval(() => {
            if (this.userId) {
                this.loadUserData();
            }
        }, 30000);
    }

    showAlert(message, type = 'info', duration = 5000) {
        // Remove existing alerts
        const existingAlerts = document.querySelectorAll('.alert-dismissible');
        existingAlerts.forEach(alert => alert.remove());
        
        const alert = document.createElement('div');
        alert.className = `alert alert-${type} alert-dismissible fade show`;
        alert.style.cssText = 'position: fixed; top: 80px; right: 20px; z-index: 1060; min-width: 300px;';
        alert.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        
        document.body.appendChild(alert);
        
        if (duration > 0) {
            setTimeout(() => {
                if (alert.parentNode) {
                    alert.remove();
                }
            }, duration);
        }
    }

    formatTime(dateString) {
        if (!dateString) return 'Unknown';
        
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} min ago`;
        if (diffHours < 24) return `${diffHours} hours ago`;
        if (diffDays < 7) return `${diffDays} days ago`;
        
        return date.toLocaleDateString();
    }
}

// Global app instance
let app;

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    app = new WhatsAppBulkSender();
});

// Global functions for HTML onclick handlers
function showSection(sectionId) {
    if (app) app.showSection(sectionId);
}

function loadUserData() {
    if (app) app.loadUserData();
}

function loadUserTasks() {
    if (app) app.loadUserTasks();
}

function loadUserStats() {
    if (app) app.loadUserStats();
}

function refreshAllGroups() {
    if (app) app.refreshAllGroups();
}
