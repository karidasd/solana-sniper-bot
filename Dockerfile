FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all project files
COPY . .

# Expose the port the app runs on (Hugging Face routes traffic to 7860 by default)
ENV PORT=7860
EXPOSE 7860

# Start the application
CMD ["npm", "start"]
