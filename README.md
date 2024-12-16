# DevTrack (･ω<)☆	

## **Track Your Development Journey with Ease!**

### What's DevTrack?

DevTrack is a productivity tool designed to seamlessly track and log your coding activities. It doesn't only provide a clear log of your coding activities but helps accurately reflect your contributions on GitHub. With a focus on simplicity and productivity, DevTrack integrates directly with your GitHub account to automatically create a history of your progress, making it easy to review, reflect, and share your work. DevTrack tracks changes to your code, commits updates to a dedicated repository, and enables you to visualize your progress over time. Whether you're working on personal projects, contributing to open source, or collaborating with a team, DevTrack is the ultimate tool for staying on top of your development journey.

---
## **Key Features**

1. **Secure GitHub Integration**: Seamlessly authenticate with your GitHub account using VS Code's secure authentication system, ensuring your credentials are safely managed.

2. **Automated Activity Monitoring**: Track your coding progress automatically in the background, capturing changes to your workspace files while respecting your privacy preferences.

3. **Intelligent Version Control**: Maintain a dedicated `code-tracking` repository on GitHub that automatically documents your coding journey through organized commit histories. Each commit captures the essence of your development session.

4. **Flexible Configuration Options**: 
   - Customize commit frequency to match your workflow
   - Define specific file patterns to exclude from tracking
   - Toggle commit confirmation dialogs
   - Specify custom repository names for activity logging

5. **Real-Time Status Indicators**: Stay informed about your tracking status through VS Code's status bar, providing immediate visibility into:
   - Active tracking status
   - Last commit timestamp
   - GitHub connection status
   - Sync status with remote repository

6. **Seamless Workspace Integration**: Works quietly in the background of any VS Code workspace, requiring minimal setup while maintaining a comprehensive record of your development activities.

7. **Smart Synchronization**: 
   - Handles remote repository management automatically
   - Resolves conflicts intelligently
   - Maintains data integrity across multiple development sessions
   - Preserves your existing workspace configurations

8. **Development Timeline**: 
   - Creates a chronological record of your coding activities
   - Documents file modifications and project progress
   - Maintains a searchable history of your development journey
   - Helps track time invested in different projects
   
---

## **Getting Started**
1. **Install the Extension**:
   - **You must install [Git](https://git-scm.com/downloads) if you haven't already in order for DevTrack to work**
   - Open Visual Studio Code.
   - Go to the Extensions Marketplace (`Ctrl+Shift+X` or `Cmd+Shift+X`).
   - Search for "DevTrack" and click "Install." 
(**Alternatively**: Install [DevTrack](https://marketplace.visualstudio.com/items?itemName=TeannaCole.devtrack) from VS Code Marketplace)

3. **Log in to GitHub**:
   - Click the GitHub icon in the VS Code status bar.
   - Authenticate with your GitHub account.
     
4. Choose your tracking preferences in VS Code Settings (`Ctrl+,` or `Cmd+,`):
```json
{
  "devtrack.repoName": "code-tracking",
  "devtrack.commitFrequency": 30,
  "devtrack.exclude": [
    "node_modules",
    "dist",
    ".git"
  ]
}
```
4. Start tracking with `DevTrack: Start Tracking` command in the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
5. **View Your Progress**:
   - Visit your `code-tracking` repository on GitHub to see your logs.

Want to showcase your DevTrack usage? [Open a PR](https://github.com/Teamial/DevTrack/pulls) to add your example!

---
## Windows Installation Guide

If you're using Windows, please follow these steps to ensure DevTrack works correctly:

1. Install Git for Windows
   - Download Git from https://git-scm.com/download/windows
   - During installation:
     - Select "Use Git from the Command Line and also from 3rd-party software"
     - Choose "Use Windows' default console window"
     - Select "Enable Git Credential Manager"
     - All other options can remain default

2. Configure Git (Run in Command Prompt or PowerShell)
   ```powershell
   git config --global core.autocrlf true
   git config --global core.safecrlf false
   git config --global core.longpaths true

3. **Refer back to Getting Started section**
---
## Preview Example

![Project Tracking Example](https://github.com/user-attachments/assets/eeab8b20-203d-441c-af2e-969c6cdeb980)
- Repository: [code-tracking](https://github.com/Teamial/code-tracking)
- Shows daily coding patterns
- Tracks multiple project files
- Automatic commits every 30 minutes
  
---
## For Contributors

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/<YourUsername>/code-tracking.git
   cd code-tracking
   ```

2. **Create a New Branch**:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

3. **Install Dependencies**:
   ```bash
   npm install
   ```

4. **Run the Extension**:
   - Open the project in VS Code.
   - Press `F5` to start debugging the extension.

5. **Contribute**:
   - Follow the Contributor Expectations outlined below.

---

## **Contributor Expectations**

Contributions to improve DevTrack are always welcome! Here's how you can help:

- **Open an Issue First**: Before submitting a pull request, file an issue explaining the bug or feature.
- **Test Your Changes**: Verify that your contributions don't break existing functionality.
- **Squash Commits**: Consolidate multiple commits into a single, meaningful one before opening a pull request.

---

### **Start Tracking Your Coding Journey with DevTrack Today!**
[**Buy Me a Coffee!**](https://marketplace.visualstudio.com/items?itemName=TeannaCole.devtrack)

