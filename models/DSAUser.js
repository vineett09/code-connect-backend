class DSAUser {
  constructor(id, name, socketId, sessionId, email) {
    this.id = id;
    this.name = name;
    this.email = email;
    this.socketId = socketId;
    this.sessionId = sessionId;
    this.color = this.generateColor();
    this.currentLanguage = "javascript";
    this.disconnected = false;
    this.disconnectedAt = null;
    this.stats = {
      totalSubmissions: 0,
      acceptedSubmissions: 0,
      totalScore: 0,
      averageTime: 0,
      preferredLanguage: "javascript",
    };
    this.currentSubmission = null;
    this.lastSubmissionTime = null;
  }

  generateColor() {
    const colors = [
      "#FF6B6B",
      "#4ECDC4",
      "#45B7D1",
      "#96CEB4",
      "#FFEAA7",
      "#DDA0DD",
      "#98D8C8",
      "#F7DC6F",
      "#BB8FCE",
      "#85C1E9",
      "#FF8A80",
      "#80CBC4",
      "#81C784",
      "#FFB74D",
      "#F06292",
      "#9575CD",
      "#4FC3F7",
      "#AED581",
      "#FFD54F",
      "#A1887F",
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  setLanguage(language) {
    this.currentLanguage = language;
    this.stats.preferredLanguage = language;
  }

  updateStats(submission) {
    this.stats.totalSubmissions++;
    if (submission.status === "accepted") {
      this.stats.acceptedSubmissions++;
      this.stats.totalScore += submission.score;
    }
  }

  setCurrentSubmission(submission) {
    this.currentSubmission = submission;
  }

  clearCurrentSubmission() {
    this.currentSubmission = null;
  }

  getAcceptanceRate() {
    if (this.stats.totalSubmissions === 0) return 0;
    return (this.stats.acceptedSubmissions / this.stats.totalSubmissions) * 100;
  }

  markAsDisconnected() {
    this.disconnected = true;
    this.disconnectedAt = new Date();
  }

  reconnect(newSocketId) {
    this.socketId = newSocketId;
    this.disconnected = false;
    this.disconnectedAt = null;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      color: this.color,
      currentLanguage: this.currentLanguage,
      disconnected: this.disconnected,
      stats: this.stats,
      acceptanceRate: this.getAcceptanceRate(),
      currentSubmission: this.currentSubmission
        ? {
            id: this.currentSubmission.id,
            status: this.currentSubmission.status,
            submittedAt: this.currentSubmission.submittedAt,
          }
        : null,
    };
  }
}

module.exports = DSAUser;
