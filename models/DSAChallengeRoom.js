const { v4: uuidv4 } = require("uuid");
const config = require("../config/config");

class DSAChallengeRoom {
  constructor(id, name, difficulty, isPrivate, createdBy) {
    this.id = id;
    this.name = name;
    this.difficulty = difficulty;
    this.isPrivate = isPrivate;
    this.createdBy = createdBy;
    this.users = [];
    this.topic = "any";
    this.currentChallenge = null;
    this.challengeHistory = [];
    this.userSubmissions = new Map();
    this.leaderboard = new Map();
    this.userCodes = new Map();
    this.status = "waiting";
    this.timeLimit = 30 * 60 * 1000;
    this.startTime = null;
    this.endTime = null;
    this.createdAt = new Date();
    this.lastActivity = new Date();
  }

  addUser(user) {
    if (this.isFull()) {
      throw new Error("Room is full");
    }
    this.users.push(user);
    this.leaderboard.set(user.id, 0);
    this.userSubmissions.set(user.id, []);
    this.lastActivity = new Date();
  }

  removeUser(userId) {
    this.users = this.users.filter((user) => user.id !== userId);
    this.leaderboard.delete(userId);
    this.userSubmissions.delete(userId);
    this.lastActivity = new Date();
  }

  isFull() {
    return this.users.length >= config.appSettings.maxUsersPerRoom;
  }

  setCurrentChallenge(challenge) {
    this.currentChallenge = {
      id: challenge.id || challenge.challengeId || uuidv4(), // FALLBACK LOGIC
      challengeId: challenge.challengeId || challenge.id, // ENSURE BOTH EXIST
      ...challenge,
      startTime: new Date(),
      endTime: new Date(Date.now() + this.timeLimit),
    };
    this.challengeHistory.push(this.currentChallenge);
    this.status = "active";
    this.startTime = new Date();
    this.endTime = new Date(Date.now() + this.timeLimit);
    this.lastActivity = new Date();
  }

  submitSolution(userId, solution) {
    if (!this.currentChallenge || this.status !== "active") {
      return { success: false, message: "No active challenge" };
    }

    const submission = {
      id: uuidv4(),
      userId,
      challengeId: this.currentChallenge.id,
      solution,
      language: solution.language,
      code: solution.code,
      submittedAt: new Date(),
      status: "pending",
      testResults: null,
      score: 0,
    };

    const userSubmissions = this.userSubmissions.get(userId) || [];
    userSubmissions.push(submission);
    this.userSubmissions.set(userId, userSubmissions);
    this.lastActivity = new Date();

    return { success: true, submission };
  }

  updateSubmissionResult(submissionId, result) {
    for (const [userId, submissions] of this.userSubmissions.entries()) {
      const submission = submissions.find((s) => s.id === submissionId);
      if (submission) {
        submission.status = result.status;
        submission.testResults = result.testResults;
        submission.score = result.score;

        if (result.status === "accepted") {
          const currentScore = this.leaderboard.get(userId) || 0;
          this.leaderboard.set(userId, currentScore + result.score);
        }

        this.lastActivity = new Date();
        return { success: true, submission };
      }
    }
    return { success: false, message: "Submission not found" };
  }

  getLeaderboard() {
    return Array.from(this.leaderboard.entries())
      .map(([userId, score]) => {
        const user = this.users.find((u) => u.id === userId);
        return {
          userId,
          userName: user ? user.name : "Unknown",
          userColor: user ? user.color : "#000000",
          score,
          submissions: this.userSubmissions.get(userId)?.length || 0,
          acceptedSubmissions:
            this.userSubmissions
              .get(userId)
              ?.filter((s) => s.status === "accepted").length || 0,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  getUserSubmissions(userId) {
    return this.userSubmissions.get(userId) || [];
  }

  endChallenge() {
    this.status = "completed";
    this.endTime = new Date();
    this.lastActivity = new Date();
  }

  resetChallenge() {
    this.currentChallenge = null;
    this.status = "waiting";
    this.startTime = null;
    this.endTime = null;
    this.lastActivity = new Date();
  }

  isTimeUp() {
    if (!this.endTime || this.status !== "active") return false;
    return new Date() > this.endTime;
  }

  getRemainingTime() {
    if (!this.endTime || this.status !== "active") return 0;
    const remaining = this.endTime.getTime() - Date.now();
    return Math.max(0, remaining);
  }

  getRoomDataForUser(userId) {
    return {
      room: this.toJSON(),
      submissions: this.getUserSubmissions(userId),
      leaderboard: this.getLeaderboard(),
      userCode: this.userCodes.get(userId) || "",
    };
  }

  saveUserCode(userId, code) {
    this.userCodes.set(userId, code);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      difficulty: this.difficulty,
      isPrivate: this.isPrivate,
      createdBy: this.createdBy,
      userCount: this.users.length,
      status: this.status,
      timeLimit: this.timeLimit,
      remainingTime: this.getRemainingTime(),
      currentChallenge: this.currentChallenge,
      leaderboard: this.getLeaderboard(),
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      users: this.users.map((user) => ({
        id: user.id,
        name: user.name,
        color: user.color,
        disconnected: user.disconnected,
      })),
    };
  }
}

module.exports = DSAChallengeRoom;
