
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    // =========================
    // BASIC USER INFORMATION
    // =========================
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    phone: {
      type: String,
      default: "",
      trim: true,
    },

    profilePhoto: {
      type: String,
      default: null,
      trim: true,
    },

    // S3 object key behind profilePhoto's URL (needed to safely
    // delete/replace the image without parsing it back out of the URL)
    profilePhotoKey: {
      type: String,
      default: null,
      trim: true,
    },

    // =========================
    // AUTHENTICATION
    // =========================
    password: {
      type: String,
      required: true,
    },

    passwordChangedAt: {
      type: Date,
      default: null,
    },

    // =========================
    // ROLE & BRANCH
    // =========================
    role: {
      type: String,
      enum: ["SUPER_ADMIN", "BRANCH_ADMIN", "STAFF"],
      default: "STAFF",
      required: true,
    },

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },

    // =========================
    // USER STATUS
    // =========================
    isActive: {
      type: Boolean,
      default: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    // =========================
    // LOGIN TRACKING
    // =========================
    lastLoginAt: {
      type: Date,
      default: null,
    },

    // =========================
    // AUDIT FIELDS
    // =========================
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ============================================================
// BRANCH REQUIRED FOR BRANCH_ADMIN / STAFF
// ============================================================
// BRANCH_ADMIN and STAFF accounts must always have a real branch
// assigned - already enforced in controller code (createAdmin,
// manageUser, creatStaff, all via resolveActiveBranch()), but
// backstopped here at the schema level too, so ANY write that goes
// through Mongoose - not just those specific controllers - is
// protected, including future endpoints someone adds without
// remembering the check. Cannot protect against a write made directly
// against MongoDB outside this app entirely (mongosh/Compass/a
// one-off script) - Mongoose middleware never runs for those; per
// CLAUDE.md's documented incident, that's exactly how this class of
// problem has happened before.
//
// Implemented as `pre` middleware (not a schema-level `validate`)
// so it fires on every write automatically, regardless of whether a
// future call remembers to pass `runValidators: true` - same
// approach Purchase.modal.js already uses for its own frozen-field
// guards.
const requiresBranch = (role) => role === "BRANCH_ADMIN" || role === "STAFF";

// No `next` callback parameter - this project runs Mongoose 9.x, which
// dropped support for callback-style middleware entirely. A hook must
// now be synchronous (throw to reject) or return a Promise/be async
// (reject/throw to reject) - the old `function(next) {...; next();}`
// style silently breaks with "next is not a function" since Kareem no
// longer passes a real callback. No I/O needed here, so plain sync.
userSchema.pre("save", function () {
  if (requiresBranch(this.role) && !this.branchId) {
    throw new Error("branchId is required when role is BRANCH_ADMIN or STAFF");
  }
});

// Query-level updates (findByIdAndUpdate/updateOne/findOneAndUpdate)
// never construct a Document and never trigger pre('save') - this
// looks up the target's CURRENT role/branchId first, merges in
// whatever the update itself is actually changing, and validates the
// resulting effective state (an update that only touches, say,
// `name` or `password` and never mentions role/branchId at all skips
// the lookup entirely and is always allowed through untouched).
async function guardUserBranchRequirement() {
  const update = this.getUpdate() || {};
  const set = update.$set || update;

  if (!("role" in set) && !("branchId" in set)) return;

  const current = await this.model.findOne(this.getQuery()).select("role branchId").lean();
  if (!current) return;

  const effectiveRole = "role" in set ? set.role : current.role;
  const effectiveBranchId = "branchId" in set ? set.branchId : current.branchId;

  if (requiresBranch(effectiveRole) && !effectiveBranchId) {
    throw new Error("branchId is required when role is BRANCH_ADMIN or STAFF");
  }
}

userSchema.pre("findOneAndUpdate", guardUserBranchRequirement);
userSchema.pre("updateOne", { document: false, query: true }, guardUserBranchRequirement);
userSchema.pre("updateMany", guardUserBranchRequirement);

const User = mongoose.model("User", userSchema);

export default User;
 


