const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Middleware
app.use(cors({
  origin: "http://localhost:8000",
  methods: ["GET", "POST"]
}));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Create uploads directory if it doesn't exist
const fs = require('fs');
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Socket.io Chat Server is running!' });
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    url: `http://localhost:4000/uploads/${req.file.filename}`
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:8000",
    methods: ["GET", "POST"]
  }
});

// In-memory storage for demo purposes
let onlineUsers = new Map(); // socketId -> user info
let rooms = new Map(); // roomId -> room info
let messages = new Map(); // roomId -> messages array
let privateMessages = new Map(); // userId -> messages array

// Initialize default global room
rooms.set('global', {
  id: 'global',
  name: 'Global Chat',
  type: 'public',
  users: new Set()
});
messages.set('global', []);

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Handle user joining
  socket.on('join', ({ username, room = 'global' }) => {
    try {
      const userInfo = {
        id: socket.id,
        username,
        room,
        joinedAt: new Date().toISOString()
      };

      socket.username = username;
      socket.room = room;
      onlineUsers.set(socket.id, userInfo);
      
      // Join the room
      socket.join(room);
      
      // Add user to room
      if (rooms.has(room)) {
        rooms.get(room).users.add(socket.id);
      }

      // Send existing messages to the user
      const roomMessages = messages.get(room) || [];
      socket.emit('previous-messages', roomMessages);

      // Get online users in the room
      const roomUsers = Array.from(rooms.get(room)?.users || [])
        .map(id => onlineUsers.get(id))
        .filter(Boolean);

      // Notify others in the room
      socket.to(room).emit('user-joined', {
        user: userInfo,
        message: `${username} joined the chat`,
        onlineUsers: roomUsers
      });

      // Send current online users to the new user
      socket.emit('online-users', roomUsers);

      console.log(`${username} joined room: ${room}`);
    } catch (error) {
      console.error('Error in join event:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Handle chat messages
  socket.on('message', (data, callback) => {
    try {
      const messageId = uuidv4();
      const message = {
        id: messageId,
        username: socket.username,
        text: data.text,
        timestamp: new Date().toISOString(),
        room: socket.room,
        reactions: {},
        readBy: [socket.id]
      };

      // Store message
      if (!messages.has(socket.room)) {
        messages.set(socket.room, []);
      }
      messages.get(socket.room).push(message);

      // Broadcast to all users in the room
      io.to(socket.room).emit('message', message);

      // Send acknowledgment
      if (callback) callback({ status: 'ok', messageId });

      console.log(`Message from ${socket.username} in ${socket.room}: ${data.text}`);
    } catch (error) {
      console.error('Error in message event:', error);
      if (callback) callback({ status: 'error', error: error.message });
    }
  });

  // Handle typing indicators
  socket.on('typing', (data) => {
    try {
      socket.to(socket.room).emit('typing', {
        username: socket.username,
        isTyping: data.isTyping
      });
    } catch (error) {
      console.error('Error in typing event:', error);
    }
  });

  // Handle private messages
  socket.on('private-message', (data, callback) => {
    try {
      const messageId = uuidv4();
      const message = {
        id: messageId,
        from: socket.username,
        fromId: socket.id,
        to: data.to,
        toId: data.toId,
        text: data.text,
        timestamp: new Date().toISOString(),
        type: 'private'
      };

      // Store private message
      const conversationKey = [socket.id, data.toId].sort().join('-');
      if (!privateMessages.has(conversationKey)) {
        privateMessages.set(conversationKey, []);
      }
      privateMessages.get(conversationKey).push(message);

      // Send to recipient
      io.to(data.toId).emit('private-message', message);
      
      // Send back to sender for confirmation
      socket.emit('private-message', message);

      if (callback) callback({ status: 'ok', messageId });

      console.log(`Private message from ${socket.username} to ${data.to}`);
    } catch (error) {
      console.error('Error in private-message event:', error);
      if (callback) callback({ status: 'error', error: error.message });
    }
  });

  // Handle message reactions
  socket.on('react-message', (data) => {
    try {
      const { messageId, reaction, room } = data;
      const roomMessages = messages.get(room);
      
      if (roomMessages) {
        const message = roomMessages.find(msg => msg.id === messageId);
        if (message) {
          if (!message.reactions[reaction]) {
            message.reactions[reaction] = [];
          }
          
          // Toggle reaction
          const userIndex = message.reactions[reaction].indexOf(socket.username);
          if (userIndex > -1) {
            message.reactions[reaction].splice(userIndex, 1);
          } else {
            message.reactions[reaction].push(socket.username);
          }

          // Broadcast reaction update
          io.to(room).emit('message-reaction', {
            messageId,
            reactions: message.reactions
          });
        }
      }
    } catch (error) {
      console.error('Error in react-message event:', error);
    }
  });

  // Handle read receipts
  socket.on('mark-read', (data) => {
    try {
      const { messageId, room } = data;
      const roomMessages = messages.get(room);
      
      if (roomMessages) {
        const message = roomMessages.find(msg => msg.id === messageId);
        if (message && !message.readBy.includes(socket.id)) {
          message.readBy.push(socket.id);
          
          // Notify message sender about read receipt
          io.to(room).emit('message-read', {
            messageId,
            readBy: message.readBy.length
          });
        }
      }
    } catch (error) {
      console.error('Error in mark-read event:', error);
    }
  });

  // Handle room creation
  socket.on('create-room', (data, callback) => {
    try {
      const roomId = uuidv4();
      const room = {
        id: roomId,
        name: data.name,
        type: data.type || 'public',
        creator: socket.username,
        users: new Set([socket.id]),
        createdAt: new Date().toISOString()
      };

      rooms.set(roomId, room);
      messages.set(roomId, []);

      if (callback) callback({ status: 'ok', room });

      // Broadcast new room to all users
      io.emit('room-created', room);

      console.log(`Room created: ${data.name} by ${socket.username}`);
    } catch (error) {
      console.error('Error in create-room event:', error);
      if (callback) callback({ status: 'error', error: error.message });
    }
  });

  // Handle room switching
  socket.on('switch-room', (data) => {
    try {
      const { roomId } = data;
      const oldRoom = socket.room;

      // Leave old room
      if (oldRoom && rooms.has(oldRoom)) {
        socket.leave(oldRoom);
        rooms.get(oldRoom).users.delete(socket.id);
        
        // Notify old room about user leaving
        socket.to(oldRoom).emit('user-left', {
          username: socket.username,
          message: `${socket.username} left the chat`
        });
      }

      // Join new room
      socket.room = roomId;
      socket.join(roomId);
      
      if (rooms.has(roomId)) {
        rooms.get(roomId).users.add(socket.id);
      }

      // Send room messages and users
      const roomMessages = messages.get(roomId) || [];
      const roomUsers = Array.from(rooms.get(roomId)?.users || [])
        .map(id => onlineUsers.get(id))
        .filter(Boolean);

      socket.emit('room-switched', {
        room: rooms.get(roomId),
        messages: roomMessages,
        onlineUsers: roomUsers
      });

      // Notify new room about user joining
      socket.to(roomId).emit('user-joined', {
        user: onlineUsers.get(socket.id),
        message: `${socket.username} joined the chat`
      });

      console.log(`${socket.username} switched to room: ${roomId}`);
    } catch (error) {
      console.error('Error in switch-room event:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    try {
      const userInfo = onlineUsers.get(socket.id);
      if (userInfo) {
        const { username, room } = userInfo;
        
        // Remove from online users
        onlineUsers.delete(socket.id);
        
        // Remove from room
        if (rooms.has(room)) {
          rooms.get(room).users.delete(socket.id);
        }

        // Get remaining online users in the room
        const roomUsers = Array.from(rooms.get(room)?.users || [])
          .map(id => onlineUsers.get(id))
          .filter(Boolean);

        // Notify others in the room
        socket.to(room).emit('user-left', {
          username,
          message: `${username} left the chat`,
          onlineUsers: roomUsers
        });

        console.log(`${username} disconnected from room: ${room}`);
      }
    } catch (error) {
      console.error('Error in disconnect event:', error);
    }
  });

  // Handle search messages
  socket.on('search-messages', (data, callback) => {
    try {
      const { query, room } = data;
      const roomMessages = messages.get(room) || [];
      
      const searchResults = roomMessages.filter(msg => 
        msg.text.toLowerCase().includes(query.toLowerCase()) ||
        msg.username.toLowerCase().includes(query.toLowerCase())
      );

      if (callback) callback({ status: 'ok', results: searchResults });
    } catch (error) {
      console.error('Error in search-messages event:', error);
      if (callback) callback({ status: 'error', error: error.message });
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Chat server running on port ${PORT}`);
  console.log(`📁 File uploads available at http://localhost:${PORT}/uploads`);
});
