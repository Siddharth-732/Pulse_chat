import { User } from "../models/user.models.js";
import {
  uploadOnCloudinary,
  deleteFromCloudinary,
} from "../utils/cloudinary.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { emailQueue, redisClient } from "../utils/emailQueue.js";
import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const sendOTP = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const otpHash = crypto.createHash("sha256").update(otp).digest("hex");

    await redisClient.set(`otp:${normalizedEmail}`, otpHash, "EX", 300);

    await emailQueue.add("send-otp", {
      email: normalizedEmail,
      otp,
    });

    return res.status(200).json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Error in sendOTP:", error);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
};

export const verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    if (otp.toString().length !== 6) {
      return res.status(400).json({ error: "OTP must be exactly 6 digits" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const storedHash = await redisClient.get(`otp:${normalizedEmail}`);

    if (!storedHash) {
      return res.status(400).json({ error: "OTP expired or invalid" });
    }

    const inputHash = crypto
      .createHash("sha256")
      .update(otp.toString())
      .digest("hex");

    if (inputHash !== storedHash) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    await redisClient.del(`otp:${normalizedEmail}`);

    const emailVerificationToken = jwt.sign(
      { email: normalizedEmail },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "15m" }, // 15 minutes to finish setting up username/avatar
    );

    return res.status(200).json({
      message: "Email verified successfully",
      emailVerificationToken,
    });
  } catch (error) {
    console.error("Error in verifyOTP:", error);
    return res.status(500).json({ error: "Failed to verify OTP" });
  }
};

export const registerUser = async (req, res) => {
  try {
    const {
      email,
      password,
      displayName,
      username,
      bio,
      institute,
      specialization,
      avatar,
      emailVerificationToken, // REQUIRED NOW
    } = req.body;

    if (!displayName || !email || !password || !username) {
      return res.status(400).json({ message: "All fields are required." });
    }

    if (!emailVerificationToken) {
      return res
        .status(400)
        .json({ message: "Email verification is required." });
    }

    try {
      // Decode the temporary token and verify it belongs to this email
      const decoded = jwt.verify(
        emailVerificationToken,
        process.env.ACCESS_TOKEN_SECRET,
      );
      if (decoded.email !== email) {
        return res
          .status(400)
          .json({ message: "Invalid verification token for this email." });
      }
    } catch (error) {
      return res
        .status(400)
        .json({ message: "Email verification token is invalid or expired." });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { username: username.toLowerCase() }],
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return res
          .status(409)
          .json({ message: "User with this email already exists." });
      }
      return res
        .status(409)
        .json({ message: "This username is already taken." });
    }

    let avatarUrl = "";

    const avatarLocalPath = req.files?.avatar?.[0]?.path;

    if (avatarLocalPath) {
      const cloudinaryResponse = await uploadOnCloudinary(avatarLocalPath);
      if (cloudinaryResponse) {
        avatarUrl = cloudinaryResponse.url; // Get the secure cloud URL
      }
    }

    const user = await User.create({
      displayName,
      email,
      password,
      avatar:
        avatarUrl || avatar || "https://default-avatar-url.com/avatar.png",
      username: username.toLowerCase(),
      bio: bio || "",
      institute: institute || "Independent Researcher",
      specialization: specialization || "General Scholar",
    });

    // We never want to send the password hash back to the frontend
    const createdUser = await User.findById(user._id).select("-password");
    if (!createdUser) {
      return res
        .status(500)
        .json({ message: "Something went wrong while registering the user." });
    }
    const accessToken = createdUser.generateAccessToken();
    const refreshToken = createdUser.generateRefreshToken();

    createdUser.refreshToken = refreshToken;
    await createdUser.save({ validateBeforeSave: false });

    const options = {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    };

    // Push a "Welcome" email job to BullMQ now that registration is fully complete
    await emailQueue.add("send-welcome", {
      email: createdUser.email,
      name: createdUser.displayName,
    });

    // Send the success response
    return res
      .status(201)
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", refreshToken, options)
      .json({
        success: true,
        message: "User registered successfully",
        user: createdUser,
      });
  } catch (error) {
    console.error("Error in registerUser:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const loginUser = async (req, res) => {
  try {
    console.log(req.body);

    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User does not exist" });
    }

    if (!user.password) {
      return res.status(400).json({
        message:
          "This account was created using Google. Please sign in with Google.",
      });
    }

    const isPasswordValid = await user.isPasswordCorrect(password);

    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid user credentials" });
    }

    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    const loggedInUser = await User.findById(user._id).select(
      "-password -refreshToken",
    );

    const cookieOptions = {
      httpOnly: true, // Prevents frontend JavaScript from reading the cookie
      secure: true, // Ensures cookies are only sent over HTTPS (or localhost)
      sameSite: "none",
    };

    return res
      .status(200)
      .cookie("accessToken", accessToken, cookieOptions)
      .cookie("refreshToken", refreshToken, cookieOptions)
      .json({
        success: true,
        message: "User logged in successfully",
        user: loggedInUser,
        accessToken,
        refreshToken,
      });
  } catch (error) {
    console.error("Error in loginUser:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const logoutUser = async (req, res) => {
  try {
    await User.findByIdAndUpdate(
      req.user._id,
      {
        $unset: {
          refreshToken: 1,
        },
      },
      {
        returnDocument: "after",
      },
    );

    const options = {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    };

    return res
      .status(200)
      .clearCookie("accessToken", options)
      .clearCookie("refreshToken", options)
      .json({
        success: true,
        message: "User logged out successfully",
      });
  } catch (error) {
    console.error("Error in logoutUser:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const refreshAccessToken = async (req, res) => {
  try {
    const incomingRefreshToken =
      req.cookies.refreshToken || req.body.refreshToken;

    if (!incomingRefreshToken) {
      return res.status(401).json({ message: "Unauthorized request" });
    }

    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET,
    );

    const user = await User.findById(decodedToken?._id);

    if (!user) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    if (incomingRefreshToken !== user?.refreshToken) {
      return res
        .status(401)
        .json({ message: "Refresh token is expired or used" });
    }

    const accessToken = user.generateAccessToken();
    const newRefreshToken = user.generateRefreshToken();

    user.refreshToken = newRefreshToken;
    await user.save({ validateBeforeSave: false });

    const options = {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    };

    return res
      .status(200)
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", newRefreshToken, options)
      .json({
        success: true,
        message: "Access token refreshed successfully",
        accessToken,
        refreshToken: newRefreshToken,
      });
  } catch (error) {
    console.error("Error in refreshAccessToken:", error.message);
    return res
      .status(401)
      .json({ message: "Invalid or expired refresh token" });
  }
};

export const updateAccountDetails = async (req, res) => {
  const { displayName, bio, avatar, username, email, phone } = req.body;

  if (
    displayName === undefined &&
    bio === undefined &&
    avatar === undefined &&
    username === undefined &&
    email === undefined &&
    phone === undefined
  ) {
    return res
      .status(400)
      .json({ message: "Please provide details to update." });
  }

  // Check for uniqueness if trying to update unique fields
  if (username) {
    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing && existing._id.toString() !== req.user._id.toString()) {
      return res.status(409).json({ message: "Username is already taken" });
    }
  }

  if (email) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing && existing._id.toString() !== req.user._id.toString()) {
      return res.status(409).json({ message: "Email is already taken" });
    }
  }

  if (phone) {
    const existing = await User.findOne({ phone });
    if (existing && existing._id.toString() !== req.user._id.toString()) {
      return res
        .status(409)
        .json({ message: "Phone number is already registered" });
    }
  }

  const user = await User.findByIdAndUpdate(
    req.user?._id,
    {
      $set: {
        ...(displayName !== undefined && { displayName }),
        ...(bio !== undefined && { bio }),
        ...(avatar !== undefined && { avatar }),
        ...(username !== undefined && { username: username.toLowerCase() }),
        ...(email !== undefined && { email: email.toLowerCase() }),
        ...(phone !== undefined && { phone }),
      },
    },
    { new: true },
  ).select("-password -refreshToken");

  return res
    .status(200)
    .json({ success: true, message: "Account details updated", user });
};
export const changeCurrentPassword = async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res
      .status(400)
      .json({ message: "Both old and new passwords are required" });
  }

  const user = await User.findById(req.user?._id);

  if (!user.password) {
    return res.status(400).json({
      message: "This is a Google Auth account. You cannot change the password.",
    });
  }

  const isPasswordCorrect = await user.isPasswordCorrect(oldPassword);
  if (!isPasswordCorrect) {
    return res.status(400).json({ message: "Invalid old password" });
  }

  user.password = newPassword;
  await user.save({ validateBeforeSave: false });

  return res
    .status(200)
    .json({ success: true, message: "Password changed successfully" });
};

export const updateUserAvatar = async (req, res) => {
  const avatarLocalPath = req.file?.path;

  if (!avatarLocalPath) {
    return res.status(400).json({ message: "Avatar file is missing" });
  }

  // Upload the new file to Cloudinary
  const avatar = await uploadOnCloudinary(avatarLocalPath);

  if (!avatar.url) {
    return res.status(400).json({ message: "Error uploading avatar to cloud" });
  }

  // Get the user's OLD avatar URL from the database
  const user = await User.findById(req.user?._id);
  const oldAvatarUrl = user.avatar;

  // Update the database with the NEW URL
  const updatedUser = await User.findByIdAndUpdate(
    req.user?._id,
    { $set: { avatar: avatar.url } },
    { returnDocument: "after" },
  ).select("-password -refreshToken");

  if (oldAvatarUrl && !oldAvatarUrl.includes("default-avatar-url")) {
    await deleteFromCloudinary(oldAvatarUrl);
  }

  return res.status(200).json({
    success: true,
    message: "Avatar updated successfully",
    user: updatedUser,
  });
};

export const updateUserBanner = async (req, res) => {
  const bannerLocalPath = req.file?.path;

  if (!bannerLocalPath) {
    return res.status(400).json({ message: "Banner file is missing" });
  }
  const banner = await uploadOnCloudinary(bannerLocalPath);

  if (!banner.url) {
    return res.status(400).json({ message: "Error uploading banner to cloud" });
  }

  // get the user's OLD banner URL from the database
  const user = await User.findById(req.user?._id);
  const oldBannerUrl = user.banner;

  // update the database with the NEW URL
  const updatedUser = await User.findByIdAndUpdate(
    req.user?._id,
    { $set: { banner: banner.url } },
    { returnDocument: "after" },
  ).select("-password -refreshToken");

  if (oldBannerUrl) {
    await deleteFromCloudinary(oldBannerUrl);
  }

  return res.status(200).json({
    success: true,
    message: "Banner updated successfully",
    user: updatedUser,
  });
};

export const getDiscoverUsers = async (req, res) => {
  try {
    const { search } = req.query;
    // req.user comes from your authentication middleware
    const loggedInUserId = req.user._id;

    const currentUser = await User.findById(loggedInUserId);
    const excludedIds = [
      loggedInUserId,
      ...currentUser.peers,
      ...currentUser.pendingRequests,
    ];

    const query = { _id: { $nin: excludedIds } };

    if (search) {
      query.$or = [
        { displayName: { $regex: search, $options: "i" } },
        { username: { $regex: search, $options: "i" } },
      ];
    }

    const filteredUsers = await User.find(query).select("-password").lean();

    // Recommendation Scoring Engine
    const myInstituteTokens = (currentUser.institute || "")
      .toLowerCase()
      .split(/\s+/);
    const mySpecTokens = (currentUser.specialization || "")
      .toLowerCase()
      .split(/\s+/);

    filteredUsers.forEach((user) => {
      let score = 0;
      const userInstTokens = (user.institute || "").toLowerCase().split(/\s+/);
      const userSpecTokens = (user.specialization || "")
        .toLowerCase()
        .split(/\s+/);

      // Check institute matches (e.g. "iit", "nit")
      const commonInst = userInstTokens.filter(
        (token) => token.length > 2 && myInstituteTokens.includes(token),
      );
      if (commonInst.length > 0) score += 10;

      // Check specialization matches
      const commonSpec = userSpecTokens.filter(
        (token) => token.length > 2 && mySpecTokens.includes(token),
      );
      if (commonSpec.length > 0) score += 5;

      user.relevanceScore = score;
    });

    // Sort by score descending
    filteredUsers.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return res.status(200).json({
      success: true,
      data: filteredUsers,
    });
  } catch (error) {
    console.error("Error in getDiscoverUsers: ", error.message);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const checkUsername = async (req, res) => {
  try {
    const { username } = req.query;

    if (!username) {
      return res
        .status(400)
        .json({ message: "Username query parameter is required" });
    }
    const existingUser = await User.findOne({
      username: username.toLowerCase(),
    });

    if (existingUser) {
      return res
        .status(200)
        .json({ available: false, message: "Username is already taken" });
    }

    return res
      .status(200)
      .json({ available: true, message: "Username is available" });
  } catch (error) {
    console.error("Error in checkUsername: ", error.message);
    return res
      .status(500)
      .json({ message: "Internal server error from username check" });
  }
};

export const sendPeerRequest = async (req, res) => {
  try {
    const { peerId } = req.params;
    const loggedInUserId = req.user._id;

    if (peerId === loggedInUserId.toString()) {
      return res
        .status(400)
        .json({ message: "Cannot send request to yourself" });
    }

    const targetUser = await User.findById(peerId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if already peers
    if (targetUser.peers.includes(loggedInUserId)) {
      return res.status(400).json({ message: "Already peers" });
    }

    // Check if request already sent
    if (targetUser.pendingRequests.includes(loggedInUserId)) {
      return res.status(400).json({ message: "Request already sent" });
    }

    targetUser.pendingRequests.push(loggedInUserId);
    await targetUser.save({ validateBeforeSave: false });

    return res
      .status(200)
      .json({ success: true, message: "Peer request sent" });
  } catch (error) {
    console.error("Error in sendPeerRequest:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const acceptPeerRequest = async (req, res) => {
  try {
    const { peerId } = req.params;
    const loggedInUserId = req.user._id;

    const loggedInUser = await User.findById(loggedInUserId);
    const targetUser = await User.findById(peerId);

    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if request exists
    if (!loggedInUser.pendingRequests.includes(peerId)) {
      return res
        .status(400)
        .json({ message: "No pending request from this user" });
    }

    // Remove from pending
    loggedInUser.pendingRequests = loggedInUser.pendingRequests.filter(
      (id) => id.toString() !== peerId,
    );

    // Add to peers for both
    if (!loggedInUser.peers.includes(peerId)) {
      loggedInUser.peers.push(peerId);
    }
    if (!targetUser.peers.includes(loggedInUserId)) {
      targetUser.peers.push(loggedInUserId);
    }

    await loggedInUser.save({ validateBeforeSave: false });
    await targetUser.save({ validateBeforeSave: false });

    return res
      .status(200)
      .json({ success: true, message: "Peer request accepted" });
  } catch (error) {
    console.error("Error in acceptPeerRequest:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const rejectPeerRequest = async (req, res) => {
  try {
    const { peerId } = req.params;
    const loggedInUserId = req.user._id;

    const loggedInUser = await User.findById(loggedInUserId);

    // Remove from pending
    loggedInUser.pendingRequests = loggedInUser.pendingRequests.filter(
      (id) => id.toString() !== peerId,
    );

    await loggedInUser.save({ validateBeforeSave: false });

    return res
      .status(200)
      .json({ success: true, message: "Peer request rejected" });
  } catch (error) {
    console.error("Error in rejectPeerRequest:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const removePeer = async (req, res) => {
  try {
    const { peerId } = req.params;
    const loggedInUserId = req.user._id;

    const loggedInUser = await User.findById(loggedInUserId);
    const targetUser = await User.findById(peerId);

    if (loggedInUser) {
      loggedInUser.peers = loggedInUser.peers.filter(
        (id) => id.toString() !== peerId,
      );
      await loggedInUser.save({ validateBeforeSave: false });
    }

    if (targetUser) {
      targetUser.peers = targetUser.peers.filter(
        (id) => id.toString() !== loggedInUserId.toString(),
      );
      await targetUser.save({ validateBeforeSave: false });
    }

    return res.status(200).json({ success: true, message: "Peer removed" });
  } catch (error) {
    console.error("Error in removePeer:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getPeers = async (req, res) => {
  try {
    const loggedInUserId = req.user._id;
    const user = await User.findById(loggedInUserId).populate(
      "peers",
      "-password",
    );

    return res.status(200).json({ success: true, data: user.peers });
  } catch (error) {
    console.error("Error in getPeers:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getPeerRequests = async (req, res) => {
  try {
    const loggedInUserId = req.user._id;
    const user = await User.findById(loggedInUserId).populate(
      "pendingRequests",
      "-password",
    );

    return res.status(200).json({ success: true, data: user.pendingRequests });
  } catch (error) {
    console.error("Error in getPeerRequests:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getUserProfile = async (req, res) => {
  try {
    const { username } = req.params;

    const user = await User.findOne({ username: username.toLowerCase() })
      .select("-password -refreshToken")
      .populate("peers", "username displayName avatar bio");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({ success: true, data: user });
  } catch (error) {
    console.error("Error in getUserProfile:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getCurrentUser = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: req.user });
  } catch (error) {
    console.error("Error in getCurrentUser:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "No credential provided" });
    }

    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${credential}` },
    });
    
    if (!response.ok) {
      return res.status(401).json({ error: "Invalid Google token" });
    }

    const payload = await response.json();
    const { sub: googleId, email, name: displayName, picture: avatar } = payload;
    
    let user = await User.findOne({ email });
    
    if (user) {
      // User exists, just log them in (add googleId if they didn't have it)
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save({ validateBeforeSave: false });
      }
    } else {
      // User doesn't exist, create them
      // Generate a unique username based on their display name
      const baseUsername = displayName.toLowerCase().replace(/[^a-z0-9]/g, "");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      let username = `${baseUsername}_${randomSuffix}`;
      
      // Ensure it's unique (basic check, extremely rare to collide with random suffix)
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        username = `${baseUsername}_${Math.floor(10000 + Math.random() * 90000)}`;
      }

      user = await User.create({
        googleId,
        email,
        displayName,
        username,
        avatar,
        bio: "",
        institute: "Independent Researcher",
        specialization: "General Scholar",
      });
    }

    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    const options = {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    };

    return res
      .status(200)
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", refreshToken, options)
      .json({
        message: "Google login successful",
        user,
      });
  } catch (error) {
    console.error("Error in googleAuth:", error);
    return res.status(500).json({ error: "Google authentication failed" });
  }
};
