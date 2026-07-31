import { create } from "zustand";
import { persist } from "zustand/middleware";
import { axiosInstance, BASE_URL } from "../lib/axios";
import toast from "react-hot-toast";
import { io, Socket } from "socket.io-client";
import { AxiosError } from "axios";

export interface PopulatedPeer {
  _id: string;
  username: string;
  displayName: string;
  avatar?: string;
  bio?: string;
}

export interface AuthUser {
  _id: string;
  username: string;
  email: string;
  avatar?: string;
  banner?: string;
  displayName: string;
  bio?: string;
  specialization?: string;
  institute?: string;
  createdAt: string;
  peers?: string[] | PopulatedPeer[];
  [key: string]: unknown;
}

// Define the shape of our store for TypeScript
interface AuthState {
  authUser: AuthUser | null;
  isLoggingIn: boolean;
  isCheckingAuth: boolean;
  isRegistering: boolean;
  isUpdatingProfile: boolean;
  socket: Socket | null;
  onlineUsers: string[];
  login: (data: Record<string, unknown> | FormData) => Promise<boolean>;
  googleAuth: (credential: string) => Promise<boolean>;
  register: (data: Record<string, unknown> | FormData) => Promise<void>;
  logout: () => Promise<void>;
  connectSocket: () => void;
  disconnectSocket: () => void;
  updateAccountDetails: (data: {
    displayName?: string;
    bio?: string;
    avatar?: string;
    username?: string;
    email?: string;
    phone?: string;
  }) => Promise<boolean>;
  changePassword: (data: {
    oldPassword?: string;
    newPassword?: string;
  }) => Promise<boolean>;
  updateUserAvatar: (file: File) => Promise<boolean>;
  updateUserBanner: (file: File) => Promise<boolean>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      authUser: null,
      isLoggingIn: false,
      isCheckingAuth: false, // We don't need a loading spinner if it's persisted instantly
      isRegistering: false,
      isUpdatingProfile: false,
      onlineUsers: [],

  login: async (data) => {
    set({ isLoggingIn: true });

    try {
      const response = await axiosInstance.post("/users/login", data);
      set({ authUser: response.data.user });
      toast.success("Logged in successfully!");
      return true;
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{ message: string }>;
      toast.error(axiosError.response?.data?.message || "Failed to log in");
      return false;
    } finally {
      set({ isLoggingIn: false });
    }
  },

  register: async (data) => {
    set({ isRegistering: true });
    try {
      const response = await axiosInstance.post("/users/register", data);
      // Our backend returns the registered user in the 'user' field
      set({ authUser: response.data.user });
      toast.success("Account created successfully!");
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{ message: string }>;
      toast.error(
        axiosError.response?.data?.message || "Failed to create account",
      );
    } finally {
      set({ isRegistering: false });
    }
  },

  googleAuth: async (credential: string) => {
    set({ isLoggingIn: true });
    try {
      const res = await axiosInstance.post("/users/google-auth", { credential });
      set({ authUser: res.data.user });
      toast.success(res.data.message || "Logged in successfully!");
      get().connectSocket();
      return true;
    } catch (error) {
      if (error instanceof AxiosError) {
        toast.error(error.response?.data?.error || "Google authentication failed.");
      } else {
        toast.error("An unexpected error occurred.");
      }
      return false;
    } finally {
      set({ isLoggingIn: false });
    }
  },

  logout: async () => {
    try {
      // tell the Express backend to clear the HTTP-Only cookies
      await axiosInstance.post("/users/logout");

      // clear the user from our frontend global memory
      set({ authUser: null });

      toast.success("Logged out successfully");
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{ message: string }>;
      toast.error(axiosError.response?.data?.message || "Failed to log out");
    }
  },

  updateAccountDetails: async (data) => {
    set({ isUpdatingProfile: true });
    try {
      const response = await axiosInstance.patch("/users/update-account", data);
      set({ authUser: response.data.user });
      toast.success("Profile updated successfully");
      return true;
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{ message: string }>;
      toast.error(
        axiosError.response?.data?.message || "Failed to update profile",
      );
      return false;
    } finally {
      set({ isUpdatingProfile: false });
    }
  },

  changePassword: async (data) => {
    set({ isUpdatingProfile: true });
    try {
      await axiosInstance.post("/users/change-password", data);
      toast.success("Password changed successfully");
      return true;
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{ message: string }>;
      toast.error(
        axiosError.response?.data?.message || "Failed to change password",
      );
      return false;
    } finally {
      set({ isUpdatingProfile: false });
    }
  },

  updateUserAvatar: async (file) => {
    set({ isUpdatingProfile: true });
    try {
      const formData = new FormData();
      formData.append("avatar", file);
      const response = await axiosInstance.patch(
        "/users/update-avatar",
        formData,
      );
      set({ authUser: response.data.user });
      toast.success("Avatar updated successfully");
      return true;
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{ message: string }>;
      toast.error(
        axiosError.response?.data?.message || "Failed to update avatar",
      );
      return false;
    } finally {
      set({ isUpdatingProfile: false });
    }
  },

  updateUserBanner: async (file) => {
    set({ isUpdatingProfile: true });
    try {
      const formData = new FormData();
      formData.append("banner", file);
      const response = await axiosInstance.patch(
        "/users/update-banner",
        formData,
      );
      set({ authUser: response.data.user });
      toast.success("Banner updated successfully");
      return true;
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{ message: string }>;
      toast.error(
        axiosError.response?.data?.message || "Failed to update banner",
      );
      return false;
    } finally {
      set({ isUpdatingProfile: false });
    }
  },

  socket: null,
  connectSocket: () => {
    const { authUser, socket } = get();

    // if we aren't logged in, or the socket is already connected, do nothing!
    if (!authUser || socket?.connected) return;

    // dial the backend phone number and pass our User ID
    const newSocket = io(BASE_URL, {
      query: {
        userId: authUser._id,
      },
    });

    newSocket.connect();
    set({ socket: newSocket });
    console.log("🔌 Socket connected!");

    newSocket.on("getOnlineUsers", (userIds: string[]) => {
      set({ onlineUsers: userIds });
    });
  },

    disconnectSocket: () => {
      const { socket } = get();
      if (socket?.connected) {
        socket.disconnect();
        set({ socket: null, onlineUsers: [] });
        console.log("🔌 Socket disconnected!");
      }
    },
  }),
  {
    name: "bind-auth-storage", // name of item in the storage (must be unique)
    partialize: (state) => ({ authUser: state.authUser }), // only persist authUser
  }
));
