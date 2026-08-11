import mongoose from "mongoose";

// One document per successful login session. logoutAt stays null until
// the matching /auth/logout call closes it out (matched by sessionId,
// not "most recent", since a user can have multiple open sessions).
const loginHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Snapshot of role/branch at login time, for stable audit history
    // even if the user's role or branch is changed later.
    role: {
      type: String,
      enum: ["SUPER_ADMIN", "BRANCH_ADMIN", "STAFF"],
      required: true,
    },

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },

    sessionId: {
      type: String,
      required: true,
    },

    loginAt: {
      type: Date,
      default: Date.now,
    },

    logoutAt: {
      type: Date,
      default: null,
    },

    ipAddress: {
      type: String,
      default: "",
      trim: true,
    },

    userAgent: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

loginHistorySchema.index({ userId: 1, sessionId: 1 });

const LoginHistory = mongoose.model("LoginHistory", loginHistorySchema);

export default LoginHistory;
