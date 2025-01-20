## RxAssistant - AI Builder

Agent builder similar to Ada uses Llama3.2-1B-Instruct model under the hood.

### Prerequisites

- Ensure you have a `.env` file loaded with the necessary configurations.
- Install [pnpm](https://pnpm.io/installation) for dependency management.

### Steps to Run the Application

1. **Load Environment Variables**  
   Ensure the `.env` file is correctly set up with the required TMDB API keys and other configurations.

2. **Install pnpm**  
   Follow the [official pnpm installation guide](https://pnpm.io/installation) to install pnpm on your system.

3. **Install Dependencies**  
   Run the following command to install the required dependencies:

   ```bash
   pnpm install
   ```

4. **Start the Server**  
   Use the following command to start the development server:

   ```bash
   pnpm run dev
   ```

5. **Access the Server**  
   The development server will be available at:  
   [http://localhost:3000](http://localhost:3000)

### Feature Parity

Feature 1: Define and Customize Conversation Flows
Feature 2: Dynamic Responses Using AI
Feature 3: Function Calling and Task Execution
Feature 4: API-Driven Design for Flexibility
Feature 5: Memory and Context Handling

### Tech Stack

1. TypeScript / NodeJS / Fastify - Backend Server
2. Pinecone - Vector DB for knowledge base
3. Groq - Production grade LLM
4. SQLite - For storing structured data