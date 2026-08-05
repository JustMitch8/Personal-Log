/* ===================================================
   Contact Tracker
   auth.js

   Handles authentication and session management.
=================================================== */

/* ===================================================
   DOM
=================================================== */

const loginCard =
    document.getElementById("loginCard");

const appCard =
    document.getElementById("appCard");

const loginButton =
    document.getElementById("loginButton");

const logoutButton =
    document.getElementById("logoutButton");

const emailInput =
    document.getElementById("emailInput");

const passwordInput =
    document.getElementById("passwordInput");

/* ===================================================
   Initialise
=================================================== */

async function restoreSession() {

    hideMessage();

    const {
        data,
        error
    } = await supabase.auth.getSession();

    if (error) {

        showMessage(
            error.message,
            "error"
        );

        return;

    }

    if (data.session) {

        await loginComplete();

    }

}

/* ===================================================
   Login
=================================================== */

loginButton.addEventListener(
    "click",
    login
);

passwordInput.addEventListener(
    "keydown",
    event => {

        if (event.key === "Enter") {

            login();

        }

    }
);

async function login() {

    hideMessage();

    loginButton.disabled = true;

    loginButton.textContent =
        "Signing In...";

    const { error } =
        await supabase.auth.signInWithPassword({

            email:
                emailInput.value.trim(),

            password:
                passwordInput.value

        });

    loginButton.disabled = false;

    loginButton.textContent =
        "Sign In";

    if (error) {

        showMessage(
            error.message,
            "error"
        );

        return;

    }

    await loginComplete();

}

/* ===================================================
   Login Complete
=================================================== */

async function loginComplete() {

    loginCard.classList.add(
        "hidden"
    );

    appCard.classList.remove(
        "hidden"
    );

    logoutButton.classList.remove(
        "hidden"
    );

    hideMessage();

    try {

        await loadDatabase();

        initialiseRecommendations();

        initialiseSearch();

        initialiseEncounterScreen();

    }

    catch (error) {

        showMessage(
            error.message,
            "error"
        );

    }

}

/* ===================================================
   Logout
=================================================== */

logoutButton.addEventListener(
    "click",
    logout
);

async function logout() {

    await supabase.auth.signOut();

    loginCard.classList.remove(
        "hidden"
    );

    appCard.classList.add(
        "hidden"
    );

    logoutButton.classList.add(
        "hidden"
    );

    emailInput.value = "";

    passwordInput.value = "";

    hideMessage();

}
