# Privacy Policy for DarkForest

**Effective Date:** September 23, 2026  
**Last Updated:** September 23, 2026  

DarkForest ("we", "our", or "us") is dedicated to providing a distraction-free, privacy-first mobile launcher and routine-based productivity environment. Your privacy is paramount: DarkForest operates entirely offline on your device and does not collect, transmit, monetize, or share your personal data.

---

### 1. Zero Network Transmission & Completely Offline Architecture

DarkForest contains **no internet access permissions** (`android.permission.INTERNET` is neither requested nor present anywhere in the application manifest). 
- All data created or processed by DarkForest remains exclusively on your local device.
- No personal data, telemetry, analytics, device identifiers, crash logs, or schedule details are ever transmitted to external servers, cloud providers, or third parties.

---

### 2. Information Handled Locally on Your Device

DarkForest stores information locally using Android's encrypted Room database storage:
- **Timetables and Time Blocks:** Titles, start times, durations, recurrence rules, and active/retired states that you configure.
- **Focus Sessions & History:** Timestamps of completed focus intervals, conscious break counts, and session state logs.
- **Quick-Access Shortcuts:** App packages you designate as your pinned home screen favorites.
- **Daily Reflection Notes:** Optional text reflections, study notes, or thoughts you write on your daily log.

All of this data resides solely in local application sandbox storage and is erased permanently if you uninstall the app or clear app data in Android Settings.

---

### 3. Android Permissions & Justifications

To deliver its core distraction-management and minimalist launcher capabilities, DarkForest utilizes the following permissions:

#### a. QUERY_ALL_PACKAGES & Package Inventory
- **Purpose:** DarkForest functions as an Android Home screen replacement (Launcher). To allow you to browse, search, and select installed applications for your launcher drawer, quick-access slots, and focus mode allowed/blocked lists, the app must enumerate installed launcher activities.
- **Privacy Assurance:** Installed package information is processed strictly in-memory and in local database preferences to display app icons/labels. It is never logged externally or transmitted anywhere.

#### b. PACKAGE_USAGE_STATS (Usage Access)
- **Purpose:** During an active, timed focus session, DarkForest uses Android's `UsageStatsManager` to detect when a restricted, distracting app is brought to the foreground (for example, through notification clicks, deep links, or recent tasks). When detected, DarkForest brings forward a gentle conscious friction prompt or returns you to your home environment.
- **Privacy Assurance:** Usage statistics are evaluated instantaneously in real time on the device. DarkForest does not log your detailed browsing history or outside app activities.

#### c. FOREGROUND_SERVICE & FOREGROUND_SERVICE_SPECIAL_USE
- **Purpose:** Allows DarkForest's distraction guard monitor to remain active during your scheduled focus sessions while the screen is on or transitions occur, ensuring distraction-free enforcement isn't prematurely killed by the operating system.

#### d. POST_NOTIFICATIONS
- **Purpose:** Displays persistent focus timer countdowns and scheduled block reminders on Android 13+ (API 33+).

#### e. SET_WALLPAPER
- **Purpose:** Optional capability to set a minimalist dark ambient background corresponding with your chosen DarkForest visual theme.

---

### 4. Children’s Privacy

DarkForest does not knowingly collect or solicit any personal information from children under 13 (or under 16 in certain jurisdictions), nor does it have the technical capability to transmit data across the internet.

---

### 5. Data Retention and Deletion

Because all data is stored exclusively on your device:
- You have complete control to edit or delete any routine, note, or focus session at any time within the app.
- Deleting a timetable or note immediately removes it from local SQLite storage.
- Uninstalling DarkForest or clearing application storage in Android Settings permanently deletes all local records.

---

### 6. Changes to This Privacy Policy

If we modify this Privacy Policy in future versions, the updated version will be packaged with the app release and published at our public privacy documentation repository.

---

### 7. Contact Us

If you have questions, feedback, or inquiries regarding this Privacy Policy:
- **Project Repository:** DarkForest Open Source Project
- **Developer Inquiries:** Contact via the official Play Store developer listing support channel.
