/* ===================================================
   Contact Tracker
   utils.js

   Shared helper functions
=================================================== */

/* ===================================================
   Strings
=================================================== */

function normaliseText(text) {

    if (!text) return "";

    return text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();

}

/* ===================================================
   Dates
=================================================== */

function todayISO() {

    return new Date()
        .toISOString()
        .split("T")[0];

}

function parseISO(dateString) {

    return new Date(dateString + "T00:00:00");

}

function daysBetween(dateA, dateB) {

    const msPerDay =
        1000 * 60 * 60 * 24;

    return Math.floor(
        (parseISO(dateB) - parseISO(dateA))
        / msPerDay
    );

}

function addDays(dateString, days) {

    const d =
        parseISO(dateString);

    d.setDate(
        d.getDate() + days
    );

    return d
        .toISOString()
        .split("T")[0];

}

function formatRelativeDate(dateString) {

    if (!dateString)
        return "";

    const diff =
        daysBetween(
            dateString,
            todayISO()
        );

    if (diff === 0)
        return "Today";

    if (diff === 1)
        return "Yesterday";

    if (diff < 7)
        return diff + " days ago";

    if (diff < 30)
        return Math.floor(diff / 7)
            + " weeks ago";

    if (diff < 365)
        return Math.floor(diff / 30)
            + " months ago";

    return Math.floor(diff / 365)
        + " years ago";

}

function formatDueDate(dateString) {

    const diff =
        daysBetween(
            todayISO(),
            dateString
        );

    if (diff === 0)
        return "Due today";

    if (diff === 1)
        return "Due tomorrow";

    if (diff > 1)
        return "Due in "
            + diff
            + " days";

    if (diff === -1)
        return "1 day overdue";

    return Math.abs(diff)
        + " days overdue";

}

/* ===================================================
   Sorting
=================================================== */

function sortPeopleAlphabetically(people) {

    return [...people].sort(

        (a, b) =>

            a.name.localeCompare(
                b.name,
                undefined,
                {
                    sensitivity: "base"
                }
            )

    );

}

/* ===================================================
   Search Ranking
=================================================== */

function searchScore(personName, query) {

    const name =
        normaliseText(personName);

    const search =
        normaliseText(query);

    if (!search)
        return -1;

    const words =
        name.split(/\s+/);

    if (
        words[0].startsWith(search)
    ) {
        return 300;
    }

    for (let i = 1; i < words.length; i++) {

        if (
            words[i].startsWith(search)
        ) {
            return 200;
        }

    }

    if (
        name.includes(search)
    ) {
        return 100;
    }

    return -1;

}

/* ===================================================
   Debounce
=================================================== */

function debounce(fn, delay = 150) {

    let timeout;

    return function (...args) {

        clearTimeout(timeout);

        timeout = setTimeout(
            () => fn.apply(this, args),
            delay
        );

    };

}

/* ===================================================
   UUID
=================================================== */

function sameId(a, b) {

    return String(a) === String(b);

}

/* ===================================================
   Messages
=================================================== */

function showMessage(text, type = "success") {

    const message =
        document.getElementById(
            "message"
        );

    message.textContent =
        text;

    message.className =
        "message " + type;

}

function hideMessage() {

    const message =
        document.getElementById(
            "message"
        );

    message.className =
        "message hidden";

}

/* ===================================================
   Arrays
=================================================== */

function uniqueById(array) {

    const seen =
        new Set();

    return array.filter(item => {

        if (
            seen.has(item.id)
        ) {
            return false;
        }

        seen.add(item.id);

        return true;

    });

}
