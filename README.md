# DevTrack (･ω<)☆	

## **Track Your Development Journey with Ease!**

DevTrack is a productivity tool designed to seamlessly track and log your coding activities. It doesn't only provide a clear log of your coding activities but helps accurately reflect your contributions on GitHub. DevTrack integrates directly with your GitHub account to automatically create a history of your progress, making it easy to review, reflect, and share your work. 


---

## **About DevTrack**

DevTrack helps developers manage their projects more efficiently by providing automated logging and GitHub integration. With a focus on simplicity and productivity, DevTrack tracks changes to your code, commits updates to a dedicated repository, and enables you to visualize your progress over time. Whether you're working on personal projects, contributing to open source, or collaborating with a team, DevTrack is the ultimate tool for staying on top of your development journey.

---

## **How It Works**


1. **Authentication**: Log in securely using GitHub's Authentication API.
2. **Tracking**: Automatically track changes to your workspace files.
3. **Commit Logs**: Commit changes to your personal `code-tracking` repository on GitHub.
4. **Customization**: Configure how often DevTrack commits changes, and specify files or folders to exclude.
5. **Status Updates**: Get real-time updates via the VS Code status bar.

---

## **Installation Instructions**

### For End Users

1. **Install the Extension**:
   - Open Visual Studio Code.
   - Go to the Extensions Marketplace (`Ctrl+Shift+X` or `Cmd+Shift+X`).
   - Search for "DevTrack" and click "Install."

2. **Log in to GitHub**:
   - Click the GitHub icon in the VS Code status bar.
   - Authenticate with your GitHub account.

3. **Start Tracking**:
   - Use the `DevTrack: Start Tracking` command in the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).

4. **View Your Progress**:
   - Visit your `code-tracking` repository on GitHub to see your logs.

---

### For Contributors

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/<YourUsername>/code-tracking.git
   cd code-tracking
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Run the Extension**:
   - Open the project in VS Code.
   - Press `F5` to start debugging the extension.

4. **Contribute**:
   - Follow the Contributor Expectations outlined below.

---

## **Contributor Expectations**

We welcome contributions to improve DevTrack! Here's how you can help:

- **Open an Issue First**: Before submitting a pull request, file an issue explaining the bug or feature.
- **Test Your Changes**: Verify that your contributions don't break existing functionality.
- **Squash Commits**: Consolidate multiple commits into a single, meaningful one before opening a pull request.

---

## **Known Issues**

- **README Commit Issue**: DevTrack may accidentally commit `README.md` files from your workspace. Use the exclude patterns in the settings to prevent this.
- **Authentication Timeout**: Long sessions may require re-authentication with GitHub.

---

### **Start Tracking Your Coding Journey with DevTrack Today!**
