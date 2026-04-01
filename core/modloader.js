const modapi_modloader = "(" + (() => {
    globalThis.promisifyIDBRequest = function promisifyIDBRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    globalThis.getDatabase = async function getDatabase() {
        const dbRequest = indexedDB.open("EF_MODS");
        const db = await promisifyIDBRequest(dbRequest);

        if (!db.objectStoreNames.contains("filesystem")) {
            db.close();
            const version = db.version + 1;
            const upgradeRequest = indexedDB.open("EF_MODS", version);
            upgradeRequest.onupgradeneeded = (event) => {
                const upgradedDb = event.target.result;
                upgradedDb.createObjectStore("filesystem");
            };
            return promisifyIDBRequest(upgradeRequest);
        }

        return db;
    }

    globalThis.getMods = async function getMods() {
        const db = await getDatabase();
        const transaction = db.transaction(["filesystem"], "readonly");
        const objectStore = transaction.objectStore("filesystem");
        const object = await promisifyIDBRequest(objectStore.get("mods.txt"));
        var out = object ? (await object.text()).split("|").toSorted() : [];
        db.close();
        return out;
    }

    globalThis.getMod = async function getMod(mod) {
        const db = await getDatabase();
        const transaction = db.transaction(["filesystem"], "readonly");
        const objectStore = transaction.objectStore("filesystem");
        const object = await promisifyIDBRequest(objectStore.get("mods/" + mod));
        var out = object ? (await object.text()) : "";
        db.close();
        return out;
    }

    globalThis.saveMods = async function saveMods(mods) {
        const db = await getDatabase();
        const transaction = db.transaction(["filesystem"], "readwrite");
        const objectStore = transaction.objectStore("filesystem");
        const encoder = new TextEncoder();
        const modsData = encoder.encode(mods.toSorted().join("|"));
        const modsBlob = new Blob([modsData], { type: "text/plain" });
        await promisifyIDBRequest(objectStore.put(modsBlob, "mods.txt"));
        db.close();
    }

    globalThis.addMod = async function addMod(mod) {
        const mods = await getMods();
        mods.push("web@" + mod);
        await saveMods(mods);
    }

    globalThis.addFileMod = async function addFileMod(mod, textContents) {
        const mods = await getMods();
        if (mods.includes(mod)) {
            await removeMod(mods.indexOf(mod));
        } else {
            mods.push(mod);
        }
        await saveMods(mods);

        const db = await getDatabase();
        const transaction = db.transaction(["filesystem"], "readwrite");
        const objectStore = transaction.objectStore("filesystem");
        const encoder = new TextEncoder();
        const modsData = encoder.encode(textContents);
        const modsBlob = new Blob([modsData], { type: "text/plain" });
        await promisifyIDBRequest(objectStore.put(modsBlob, "mods/" + mod));
        db.close();
    }

    globalThis.removeMod = async function removeMod(index) {
        const mods = await getMods();
        if (index >= 0 && index < mods.length) {
            var deleted = mods.splice(index, 1)[0];
            await saveMods(mods);
            if (!deleted.startsWith("web@")) {
                const db = await getDatabase();
                const transaction = db.transaction(["filesystem"], "readwrite");
                const objectStore = transaction.objectStore("filesystem");
                await promisifyIDBRequest(objectStore.delete("mods/" + deleted));
                db.close();
            }
        }
    }

    globalThis.resetMods = async function resetMods() {
        const db = await getDatabase();
        const transaction = db.transaction(["filesystem"], "readwrite");
        const objectStore = transaction.objectStore("filesystem");
        await promisifyIDBRequest(objectStore.clear());
        db.close();
    }

    async function extractArchiveMods(file, modsArr) {
        const zip = await JSZip.loadAsync(file);

        const entries = Object.keys(zip.files);

        for (let path of entries) {
            if (!path.endsWith(".js") && !path.endsWith(".zip") && !path.endsWith(".efpack")) continue;

            const content = await zip.files[path].async("string");

            const modName = "archive@" + file.name + ":" + path;

            await addFileMod(modName, content);

            modsArr.push(modName);
        }
    }

    globalThis.modLoader = async function modLoader(modsArr = []) {
        if (!window.eaglerMLoaderMainRun) {
            var searchParams = new URLSearchParams(location.search);

            searchParams.getAll("mod").forEach((modToAdd) => {
                modsArr.push("web@" + modToAdd);
            });

            searchParams.getAll("plugin").forEach((modToAdd) => {
                modsArr.push("web@" + modToAdd);
            });

            if (window.eaglercraftXOpts?.Mods && Array.isArray(eaglercraftXOpts.Mods)) {
                eaglercraftXOpts.Mods.forEach((modToAdd) => {
                    modsArr.push("web@" + modToAdd);
                });
            }

            try {
                var idbMods = await getMods();
                modsArr = modsArr.concat(idbMods.filter(x => x && x.length > 0));
            } catch (error) {}

            window.eaglerMLoaderMainRun = true;
        }

        if (window.noLoadMods === true) {
            modsArr.splice(0, modsArr.length);
        }

        window.ModGracePeriod = true;

        var totalLoaded = 0;
        var loaderCheckInterval = null;

        modsArr.sort();

        for (let i = 0; i < modsArr.length; i++) {
            let currentMod = modsArr[i];
            let isIDBMod = !currentMod.startsWith("web@");

            if (!isIDBMod) currentMod = currentMod.replace("web@", "");

            if (currentMod.endsWith(".zip") || currentMod.endsWith(".efpack")) {
                try {
                    const res = await fetch(currentMod);
                    const blob = await res.blob();
                    await extractArchiveMods(blob, modsArr);
                    continue;
                } catch (e) {
                    continue;
                }
            }

            try {
                var responseText = isIDBMod
                    ? await getMod(currentMod)
                    : await (await fetch(currentMod)).text();

                var script = document.createElement("script");

                script.setAttribute(
                    "data-hash",
                    ModAPI.util.hashCode((isIDBMod ? "" : "web@") + currentMod)
                );

                try {
                    script.src =
                        "data:text/javascript," + encodeURIComponent(responseText);
                } catch (error) {
                    continue;
                }

                script.setAttribute("data-isMod", "true");

                script.onload = () => totalLoaded++;
                script.onerror = () => totalLoaded++;

                document.body.appendChild(script);
            } catch (error) {}
        }

        loaderCheckInterval = setInterval(() => {
            if (totalLoaded >= modsArr.length) {
                clearInterval(loaderCheckInterval);
                window.ModGracePeriod = false;

                ModAPI?.events?.callEvent?.("load", {});
            }
        }, 500);

        window.returnTotalLoadedMods = () => totalLoaded;
    };
}).toString() + ")();"

if (globalThis.process) {
    module.exports = {
        modapi_modloader: modapi_modloader
    }
}
