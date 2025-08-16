const { v4: uuidv4 } = require("uuid");
const DSAUser = require("../models/DSAUser");
const dsaRoomService = require("../services/DSAChallengeRoomService");
const axios = require("axios");
const logger = require("../utils/logger");

const handleDSAConnection = (io, socket) => {
  logger.log("DSA User connected:", socket.id);

  // Helper to send notifications
  const sendNotification = (roomId, type, message) => {
    io.to(roomId).emit("notification", { type, message });
  };

  // Join DSA challenge room
  socket.on("join-dsa-room", async (data) => {
    try {
      const { roomId, userName, sessionId, userEmail } = data;
      const room = dsaRoomService.getRoom(roomId);
      if (!userEmail) {
        socket.emit("error", { message: "User email is required to join." });
        return;
      }
      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      let user;
      let isReconnecting = false;

      if (sessionId) {
        const reconnectedUser = dsaRoomService.reconnectUser(
          roomId,
          sessionId,
          socket.id
        );
        if (reconnectedUser) {
          user = reconnectedUser;
          isReconnecting = true;
          logger.log(`${user.name} reconnected to DSA room ${roomId}`);
        }
      }

      if (!isReconnecting) {
        if (room.isFull()) {
          socket.emit("error", { message: "Room is full" });
          return;
        }
        const newSessionId = uuidv4();
        const newUserId = uuidv4();
        user = new DSAUser(
          newUserId,
          userName,
          socket.id,
          newSessionId,
          userEmail
        );
        dsaRoomService.addUserToRoom(roomId, user);
        logger.log(`${userName} joined DSA room ${roomId} for the first time`);
      }

      socket.join(roomId);

      const currentUsers = dsaRoomService.getAllUsersInRoom(roomId);
      const roomDataForUser = room.getRoomDataForUser(user.id);

      socket.emit("dsa-room-joined", {
        ...roomDataForUser,
        user: user.toJSON(),
        sessionId: user.sessionId,
        users: currentUsers.map((u) => u.toJSON()),
      });

      const eventType = isReconnecting
        ? "dsa-user-reconnected"
        : "dsa-user-joined";
      socket.to(roomId).emit(eventType, {
        user: user.toJSON(),
        users: currentUsers.map((u) => u.toJSON()),
      });

      // NOTIFICATION
      const notificationMessage = isReconnecting
        ? `${user.name} has reconnected!`
        : `${user.name} has joined the room.`;
      sendNotification(roomId, "info", notificationMessage);

      io.to(roomId).emit("dsa-users-list-sync", {
        users: currentUsers.map((u) => u.toJSON()),
      });
    } catch (error) {
      logger.error("Error in join-dsa-room:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("set-room-topic", (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;

      const { roomId, topic } = data;
      const room = dsaRoomService.getRoom(roomId);

      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      if (room.createdBy !== user.name) {
        socket.emit("error", {
          message: "Only the room creator can set the topic.",
        });
        return;
      }

      room.topic = topic;
      room.lastActivity = new Date();

      io.to(roomId).emit("room-topic-updated", { topic, updatedBy: user.name });

      // NOTIFICATION
      sendNotification(
        roomId,
        "info",
        `Topic changed to '${topic}' by ${user.name}.`
      );

      logger.log(`Topic set to '${topic}' in room ${roomId} by ${user.name}`);
    } catch (error) {
      logger.error("Error in set-room-topic:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("generate-challenge", async (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;

      const { roomId, difficulty, topic } = data;
      const room = dsaRoomService.getRoom(roomId);

      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      if (room.createdBy !== user.name && room.users.length > 1) {
        socket.emit("error", {
          message: "Only room creator can generate challenges",
        });
        return;
      }

      // Pass user email for personalized challenge selection
      const result = await dsaRoomService.generateChallenge(
        roomId,
        difficulty,
        topic,
        user.email
      );

      if (result.success) {
        // Success case - emit new challenge with cache info
        io.to(roomId).emit("new-challenge", {
          challenge: room.currentChallenge,
          generatedBy: user.name,
          room: room.toJSON(),
          cached: result.cached,
          similarity: result.similarity,
          source: result.source,
        });

        const notificationMessage = `New challenge generated by ${user.name}!`;

        sendNotification(roomId, "success", notificationMessage);

        logger.log(
          `Challenge ${
            result.cached ? "retrieved" : "generated"
          } in room ${roomId} by ${user.name} (source: ${result.source})`
        );
      } else {
        // Error case - send notification without disconnecting
        sendNotification(roomId, "error", result.error);

        // Emit specific error event for AI generation failure
        socket.emit("ai-generation-failed", {
          error: result.error,
          details: result.details,
        });

        logger.log(
          `Challenge generation failed in room ${roomId}: ${result.error}`
        );
      }
    } catch (error) {
      logger.error("Error in generate-challenge:", error);
      // Send notification instead of generic error that might disconnect
      sendNotification(
        data.roomId,
        "error",
        "An unexpected error occurred while generating the challenge."
      );
      socket.emit("ai-generation-failed", {
        error: "An unexpected error occurred. Please try again.",
        details: error.message,
      });
    }
  });

  socket.on("save-code", (data) => {
    const { roomId, code } = data;
    const user = dsaRoomService.getUserBySocketId(socket.id);
    const room = dsaRoomService.getRoom(roomId);
    if (!room || !user) return;

    room.saveUserCode(user.id, code);

    socket.emit("code-saved", {
      userId: user.id,
      roomId,
      timestamp: new Date(),
    });
  });

  socket.on("submit-solution", async (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) throw new Error("User session not found");

      const { roomId, solution } = data;
      if (!roomId || !solution || !solution.language || !solution.code) {
        throw new Error("Invalid submission data");
      }

      const room = dsaRoomService.getRoom(roomId);
      if (!room) throw new Error("Room not found");
      if (!room.currentChallenge?.id) throw new Error("No challenge is active");

      const challengeId = room.currentChallenge.id;

      // ✅ CHECK FOR ALREADY SOLVED
      const alreadySolved = dsaRoomService.hasAlreadySolved(
        roomId,
        user.id,
        challengeId
      );

      if (alreadySolved) {
        socket.emit("error", {
          message:
            "✅ You have already solved this challenge. No need to submit again.",
          code: "ALREADY_SOLVED",
        });
        return;
      }

      // ✅ RATE LIMITING (optional but recommended)
      const now = Date.now();
      if (user.lastSubmissionTime && now - user.lastSubmissionTime < 3000) {
        socket.emit("error", {
          message: "Please wait before submitting again",
          code: "RATE_LIMITED",
          remainingTime: 3000 - (now - user.lastSubmissionTime),
        });
        return;
      }
      user.lastSubmissionTime = now;

      // ✅ SUBMIT SOLUTION (no automatic evaluation)
      const result = await dsaRoomService.submitSolution(
        roomId,
        user.id,
        solution
      );

      if (!result.success) {
        throw new Error(result.message || "Submission failed");
      }

      // ✅ IMMEDIATE RESPONSE
      socket.emit("solution-submitted", {
        submission: result.submission,
        message: "Solution submitted successfully",
      });

      socket.to(roomId).emit("user-submitted", {
        userId: user.id,
        userName: user.name,
        submissionId: result.submission.id,
        submittedAt: result.submission.submittedAt,
      });

      sendNotification(
        roomId,
        "info",
        `${user.name} has submitted a solution.`
      );

      // ✅ SINGLE EVALUATION CALL WITH PROPER ERROR HANDLING
      try {
        logger.log(
          `Starting evaluation for submission ${result.submission.id}`
        );

        const evaluationResult = await dsaRoomService.evaluateSubmission(
          roomId,
          result.submission.id
        );

        if (!evaluationResult.success) {
          throw new Error(evaluationResult.message || "Evaluation failed");
        }

        // ✅ SEND EVALUATION RESULTS
        socket.emit("evaluation-result", {
          submission: evaluationResult.submission,
          testResults: evaluationResult.submission.testResults,
        });

        // ✅ MARK CHALLENGE AS SOLVED IF ACCEPTED
        if (
          evaluationResult.submission.status === "accepted" &&
          room.currentChallenge?.challengeId
        ) {
          try {
            await dsaRoomService.markChallengeAsSolved(
              roomId,
              user.id,
              room.currentChallenge.challengeId
            );
            logger.log(
              `Challenge ${room.currentChallenge.challengeId} marked as solved by ${user.email}`
            );
          } catch (markError) {
            logger.warn(
              "Failed to mark challenge as solved:",
              markError.message
            );
            // Don't fail the submission for this
          }
        }

        // ✅ UPDATE LEADERBOARD
        const leaderboard = dsaRoomService.getLeaderboard(roomId);
        io.to(roomId).emit("leaderboard-updated", {
          leaderboard,
          lastSubmission: {
            userId: user.id,
            userName: user.name,
            status: evaluationResult.submission.status,
            score: evaluationResult.submission.score,
          },
        });

        // ✅ EVALUATION NOTIFICATIONS
        if (evaluationResult.submission.status === "accepted") {
          sendNotification(
            roomId,
            "success",
            `🎉 ${user.name} passed all test cases!`
          );
        } else if (evaluationResult.submission.status === "error") {
          sendNotification(
            roomId,
            "error",
            `${user.name}'s submission had an error.`
          );
        } else {
          sendNotification(
            roomId,
            "warning",
            `${user.name}'s submission failed some test cases.`
          );
        }
      } catch (evalError) {
        logger.error("Evaluation error:", {
          error: evalError.message,
          submissionId: result.submission.id,
          roomId: roomId,
          userId: user.id,
        });

        socket.emit("error", {
          message: evalError.message || "Evaluation failed",
          code: "EVALUATION_ERROR",
          submissionId: result.submission.id,
          details: {
            canRetry: true,
            evaluationFailed: true,
          },
        });

        // ✅ NOTIFY ROOM OF EVALUATION FAILURE
        sendNotification(
          roomId,
          "error",
          `Failed to evaluate ${user.name}'s submission.`
        );
      }
    } catch (error) {
      logger.error("Submit solution error:", {
        error: error.message,
        socketId: socket.id,
        stack: error.stack,
        data,
      });

      socket.emit("error", {
        message: error.message || "Failed to submit solution",
        code: "SUBMISSION_ERROR",
        details: {
          roomId: data?.roomId,
          hasCode: !!data?.solution?.code,
          hasLanguage: !!data?.solution?.language,
          canRetry: true,
        },
      });
    }
  });

  socket.on("end-challenge", async (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;

      const { roomId } = data;
      const room = dsaRoomService.getRoom(roomId);
      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      if (room.createdBy !== user.name) {
        socket.emit("error", {
          message: "Only room creator can end challenges",
        });
        return;
      }

      const updatedRoom = dsaRoomService.endChallenge(roomId);
      const finalLeaderboard = dsaRoomService.getLeaderboard(roomId);

      // NOTIFICATION for challenge ending
      sendNotification(
        roomId,
        "warning",
        `The challenge has been ended by ${user.name}.`
      );

      // Determine the ACTUAL winner (who solved the challenge)
      const allSubmissions = [];
      room.users.forEach((u) => {
        const subs = room.getUserSubmissions(u.id);
        const solved = subs.find((s) => s.status === "accepted");
        if (solved) {
          allSubmissions.push({
            userId: u.id,
            userName: u.name,
            score: solved.score,
          });
        }
      });

      let actualWinner = null;
      if (allSubmissions.length > 0) {
        allSubmissions.sort((a, b) => b.score - a.score);
        actualWinner = allSubmissions[0];
      }

      // ONLY show winner notification if someone actually solved the challenge
      if (actualWinner) {
        sendNotification(
          roomId,
          "success",
          `🏆 ${actualWinner.userName} wins the challenge!`
        );
      } else {
        // Optional: Show a different message when no one wins
        sendNotification(
          roomId,
          "info",
          `Challenge ended with no winners. Better luck next time!`
        );
      }

      io.to(roomId).emit("challenge-ended", {
        room: updatedRoom.toJSON(),
        finalLeaderboard,
        endedBy: user.name,
      });

      logger.log(`Challenge ended in room ${roomId}. Updating user stats...`);

      try {
        for (const player of room.users) {
          if (!player.email) continue;

          const userSubmissions = room.getUserSubmissions(player.id);
          const acceptedSubmissions = userSubmissions.filter(
            (sub) => sub.status === "accepted"
          );
          const solvedProblems = acceptedSubmissions.map(
            (sub) => sub.challengeId
          );
          const totalScore = acceptedSubmissions.reduce(
            (sum, sub) => sum + (sub.score || 0),
            0
          );

          let ratingChange = 0;
          let won = false;

          if (actualWinner) {
            won = player.id === actualWinner.userId;
            if (won) {
              ratingChange = 25;
            } else if (acceptedSubmissions.length > 0) {
              ratingChange = 10;
            } else {
              ratingChange = -5;
            }
          }

          const problemDifficulties = solvedProblems.map(
            () => room.difficulty || "medium"
          );

          const payload = {
            email: player.email,
            stats: {
              won,
              ratingChange,
              solvedProblems,
              problemDifficulties,
              submissions: userSubmissions.length,
              acceptedSubmissions: acceptedSubmissions.length,
              score: totalScore,
            },
          };

          await axios.post(
            `${process.env.FRONTEND_API_URL}/api/user/update-stats`,
            payload,
            {
              headers: {
                "Content-Type": "application/json",
                "x-internal-api-key": process.env.INTERNAL_API_SECRET,
              },
            }
          );

          logger.log(`Successfully updated stats for ${player.email}`);
        }
      } catch (apiError) {
        logger.error(
          "Failed to update user stats via API:",
          apiError.response ? apiError.response.data : apiError.message
        );
      }
    } catch (error) {
      logger.error("Error in end-challenge:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("get-user-submissions", (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;
      const { roomId, userId } = data;
      const targetUserId = userId || user.id;
      const submissions = dsaRoomService.getUserSubmissions(
        roomId,
        targetUserId
      );
      socket.emit("user-submissions", { userId: targetUserId, submissions });
    } catch (error) {
      logger.error("Error in get-user-submissions:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("get-leaderboard", (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;
      const { roomId } = data;
      const leaderboard = dsaRoomService.getLeaderboard(roomId);
      socket.emit("leaderboard-data", { leaderboard });
    } catch (error) {
      logger.error("Error in get-leaderboard:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("change-language", (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;
      const { roomId, language } = data;
      user.setLanguage(language);
      socket.to(roomId).emit("user-language-changed", {
        userId: user.id,
        userName: user.name,
        language: language,
      });
    } catch (error) {
      logger.error("Error in change-language:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("get-room-info", (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;
      const { roomId } = data;
      const room = dsaRoomService.getRoom(roomId);
      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }
      socket.emit("room-info", {
        room: room.toJSON(),
        users: dsaRoomService.getAllUsersInRoom(roomId).map((u) => u.toJSON()),
      });
    } catch (error) {
      logger.error("Error in get-room-info:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("disconnect", () => {
    try {
      const disconnectionData = dsaRoomService.handleUserDisconnect(socket.id);
      if (disconnectionData) {
        const { user, roomId } = disconnectionData;
        socket.to(roomId).emit("dsa-user-disconnected", {
          userId: user.id,
          userName: user.name,
          users: dsaRoomService
            .getAllUsersInRoom(roomId)
            .map((u) => u.toJSON()),
        });

        // NOTIFICATION
        sendNotification(roomId, "warning", `${user.name} has disconnected.`);

        logger.log(`DSA User ${user.name} disconnected from room ${roomId}`);
      }
    } catch (error) {
      logger.error("Error handling disconnect:", error);
    }
  });

  socket.on("leave-room", (data) => {
    try {
      const user = dsaRoomService.getUserBySocketId(socket.id);
      if (!user) return;
      const { roomId } = data;
      dsaRoomService.removeUserPermanently(roomId, user.id);
      socket.leave(roomId);
      socket.to(roomId).emit("dsa-user-left", {
        userId: user.id,
        userName: user.name,
        users: dsaRoomService.getAllUsersInRoom(roomId).map((u) => u.toJSON()),
      });

      // NOTIFICATION
      sendNotification(roomId, "warning", `${user.name} has left the room.`);

      socket.emit("room-left", {
        message: "Successfully left the room",
        roomId,
      });
      logger.log(`User ${user.name} left room ${roomId} permanently`);
    } catch (error) {
      logger.error("Error in leave-room:", error);
      socket.emit("error", { message: error.message });
    }
  });
};

module.exports = handleDSAConnection;
