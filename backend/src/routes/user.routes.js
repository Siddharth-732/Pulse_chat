import { Router } from "express";
import {
  getDiscoverUsers,
  registerUser,
  sendOTP,
  verifyOTP,
  checkUsername,
  loginUser,
  logoutUser,
  refreshAccessToken,
  updateAccountDetails,
  changeCurrentPassword,
  updateUserAvatar,
  updateUserBanner,
  sendPeerRequest,
  acceptPeerRequest,
  rejectPeerRequest,
  removePeer,
  getPeers,
  getPeerRequests,
  getUserProfile,
  googleAuth,
  getCurrentUser,
} from "../controllers/user.controllers.js";
import { upload } from "../middleware/multer.middleware.js";
import { verifyJWT } from "../middleware/auth.middleware.js";
const router = Router();
router.route("/me").get(verifyJWT, getCurrentUser);
router.route("/send-otp").post(sendOTP);
router.route("/verify-otp").post(verifyOTP);
router.route("/check-username").get(checkUsername);
router.route("/google-auth").post(googleAuth);
router.route("/register").post(
  upload.fields([
    {
      name: "avatar",
      maxCount: 1,
    },
  ]),
  registerUser,
);
router.route("/login").post(loginUser);
router.route("/logout").post(verifyJWT, logoutUser);
router.route("/").get(verifyJWT, getDiscoverUsers);
router.route("/refresh-token").post(refreshAccessToken);
router.route("/update-account").patch(verifyJWT, updateAccountDetails);
router.route("/change-password").post(verifyJWT, changeCurrentPassword);
router.route("/update-avatar").patch(
  verifyJWT,
  upload.single("avatar"), // multer grabs the single file named "avatar"
  updateUserAvatar,
);
router
  .route("/update-banner")
  .patch(verifyJWT, upload.single("banner"), updateUserBanner);

router.route("/profile/:username").get(verifyJWT, getUserProfile);
router.route("/peers").get(verifyJWT, getPeers);
router.route("/peers/requests").get(verifyJWT, getPeerRequests);
router.route("/peers/:peerId/request").post(verifyJWT, sendPeerRequest);
router.route("/peers/:peerId/accept").post(verifyJWT, acceptPeerRequest);
router.route("/peers/:peerId/reject").post(verifyJWT, rejectPeerRequest);
router.route("/peers/:peerId/remove").post(verifyJWT, removePeer);

export default router;
