import { Server } from "socket.io";

let io = null;

/**
 * Initialize Socket.io server
 * @param {import("http").Server} httpServer 
 */
export const initSocketServer = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    // Join company room to receive updates for all tasks of a company
    socket.on("join_company", (companyId) => {
      if (companyId) {
        socket.join(`company_${companyId}`);
        console.log(`[Socket] Client ${socket.id} joined company_${companyId}`);
      }
    });

    // Join job-specific room to receive updates for a single task
    socket.on("join_job", (jobId) => {
      if (jobId) {
        socket.join(`job_${jobId}`);
        console.log(`[Socket] Client ${socket.id} joined job_${jobId}`);
      }
    });

    // Handle job status update from workers and broadcast to client rooms
    socket.on("job_status_update", (data) => {
      const { jobId, companyId, type, status, result, error } = data;
      console.log(`[Socket] Job status update from worker:`, { jobId, companyId, status });

      // Broadcast to company room and job room
      if (companyId) {
        io.to(`company_${companyId}`).emit("job_status", data);
      }
      if (jobId) {
        io.to(`job_${jobId}`).emit("job_status", data);
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Socket] Disconnected: ${socket.id}`);
    });
  });

  return io;
};

/**
 * Get Socket.io instance
 */
export const getIo = () => {
  if (!io) {
    throw new Error("Socket.io is not initialized!");
  }
  return io;
};
