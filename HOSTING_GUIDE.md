# Hosting Guide

## A. Firebase — do this first

1. Create a Firebase project.
2. Register a Web app (`</>`).
3. Copy the Firebase Web App configuration into `config.js`.
4. Open Authentication > Sign-in method and enable **Email/Password**.
5. Open Authentication > Users and create your first authorized user.
6. Open Firestore Database and create the database.
7. Open Firestore Database > Rules and publish the contents of `firebase/firestore.rules`.
8. Under Authentication > Settings > Authorized domains, add your production domain and any development host Firebase requires.
9. Test locally before deploying.

Do not put Firebase service-account private keys or other server credentials into the browser project.

## B. Vercel — recommended for the static app

### Method 1: GitHub import

1. Create a GitHub repository and upload everything inside `journal_submission_web/`.
2. Keep the repository private if you want to keep the source code private.
3. Sign in to Vercel.
4. Create a new project and import the GitHub repository.
5. Framework preset: choose `Other` (or no framework, depending on the current Vercel UI).
6. Build command: leave empty.
7. Output directory: `.` / repository root.
8. Deploy.
9. Copy the generated production URL.
10. Add that domain to Firebase Authentication > Settings > Authorized domains.
11. Test sign-in and password reset.

### Method 2: Vercel CLI

From the extracted project folder, run:

```text
vercel
```

Follow the prompts and deploy from the project root.

## C. Hostinger — static HTML/CSS/JS

1. Log in to Hostinger hPanel.
2. Open File Manager.
3. Open the `public_html` folder for the target domain.
4. Upload the ZIP or extracted files.
5. Extract the ZIP if needed.
6. Make sure `index.html` is directly inside `public_html` rather than inside an extra nested folder.
7. Confirm that `index.html`, `styles.css`, `app.js`, `config.js`, `vercel.json`, `assets/` and `firebase/` are in the website root.
8. Open your domain.
9. Add the domain to Firebase Authentication > Settings > Authorized domains.

## D. GitHub Pages

1. Create a GitHub repository.
2. Upload the contents of `journal_submission_web/` to the repository root.
3. Commit the files.
4. Open the repository Settings.
5. Open Pages under Code and automation.
6. Under Build and deployment, choose Deploy from a branch.
7. Select `main` and `/ (root)`, then save.
8. Open the published URL.
9. Add the GitHub Pages domain to Firebase Authentication > Settings > Authorized domains.

Important: GitHub Pages sites are publicly reachable. Do not place client records, JSON backups, database files or service-account keys in the repository. Client data should remain in Firestore and be protected by Authentication + Security Rules.

## Recommended architecture

```text
GitHub private repository
        ↓
Vercel / Hostinger / GitHub Pages
        ↓ HTTPS
Firebase Authentication + Cloud Firestore + Security Rules
```
