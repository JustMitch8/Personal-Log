/* ===================================================
   Contact Tracker
   database.js

   All communication with Supabase.
=================================================== */

const supabase = window.supabase.createClient(
    CONFIG.supabaseUrl,
    CONFIG.supabaseAnonKey
);

/* ===================================================
   Application Data
=================================================== */

let allPeople = [];

let allEncounters = [];

let allEncounterParticipants = [];

/* ===================================================
   Load Everything
=================================================== */

async function loadDatabase() {

    await Promise.all([
        loadPeople(),
        loadEncounters(),
        loadEncounterParticipants()
    ]);

}

/* ===================================================
   People
=================================================== */

async function loadPeople() {

    const { data, error } =
        await supabase
            .from("people")
            .select("*")
            .order("name");

    if (error)
        throw error;

    allPeople = data;

}

/* ===================================================
   Encounters
=================================================== */

async function loadEncounters() {

    const { data, error } =
        await supabase
            .from("encounters")
            .select("*")
            .order("date", {
                ascending: false
            });

    if (error)
        throw error;

    allEncounters = data;

}

/* ===================================================
   Participants
=================================================== */

async function loadEncounterParticipants() {

    const { data, error } =
        await supabase
            .from("encounter_participants")
            .select("*");

    if (error)
        throw error;

    allEncounterParticipants = data;

}

/* ===================================================
   Save Encounter
=================================================== */

async function insertEncounter(
    encounterType,
    description,
    date
) {

    const { data, error } =
        await supabase
            .from("encounters")
            .insert({

                type: encounterType,

                description: description,

                date: date

            })
            .select()
            .single();

    if (error)
        throw error;

    allEncounters.unshift(data);

    return data;

}

/* ===================================================
   Save Participants
=================================================== */

async function insertEncounterParticipants(
    encounterId,
    personIds
) {

    if (personIds.length === 0)
        return;

    const rows =
        personIds.map(id => ({

            encounterid: encounterId,

            personid: id

        }));

    const { data, error } =
        await supabase
            .from("encounter_participants")
            .insert(rows)
            .select();

    if (error)
        throw error;

    allEncounterParticipants.push(...data);

}

/* ===================================================
   Save Workflow
=================================================== */

async function saveEncounterToDatabase(
    encounterType,
    description,
    date,
    personIds
) {

    const encounter =
        await insertEncounter(
            encounterType,
            description,
            date
        );

    await insertEncounterParticipants(
        encounter.id,
        personIds
    );

    return encounter;

}
