"use client";

import React, { createContext, useContext, useEffect, useState, useRef } from "react";
import io from "socket.io-client";
import { useWalletStore } from "@/lib/store/walletStore";

interface Notification {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Minimal interface to avoid 'any' and complex type resolution issues
interface SocketInstance {
  on: (event: string, callback: (data: Notification | unknown) => void) => void;
  disconnect: () => void;
}

interface SocketContextType {
  socket: SocketInstance | null;
  connected: boolean;
  lastNotification: Notification | null;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  connected: false,
  lastNotification: null,
});

export const useSocket = () => useContext(SocketContext);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { address } = useWalletStore();
  const [socket, setSocketState] = useState<SocketInstance | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastNotification, setLastNotification] = useState<Notification | null>(null);
  const socketRef = useRef<SocketInstance | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scheduleStateUpdate = (fn: () => void) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(fn, 0);
    };

    if (!address) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        scheduleStateUpdate(() => {
          setSocketState(null);
          setConnected(false);
        });
      }
      return;
    }

    const socketUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

    const newSocket = io(socketUrl, {
      query: { address },
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    }) as unknown as SocketInstance;

    newSocket.on("connect", () => {
      setConnected(true);
      console.log("WebSocket connected");
    });

    newSocket.on("disconnect", () => {
      setConnected(false);
      console.log("WebSocket disconnected");
    });

    newSocket.on("notification", (data: unknown) => {
      setLastNotification(data as Notification);
      console.log("New notification received:", data);
    });

    socketRef.current = newSocket;
    scheduleStateUpdate(() => {
      setSocketState(newSocket);
    });

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        scheduleStateUpdate(() => {
          setSocketState(null);
        });
      }
    };
  }, [address]);

  return (
    <SocketContext.Provider value={{ socket, connected, lastNotification }}>
      {children}
    </SocketContext.Provider>
  );
};
