/* ==========================================
   Contact Tracker
   app.js

   Application entry point
========================================== */

document.addEventListener(
    "DOMContentLoaded",
    initialiseApplication
);

async function initialiseApplication() {

    initialiseUI();

    await restoreSession();

}
