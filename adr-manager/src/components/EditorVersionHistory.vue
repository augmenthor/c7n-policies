<template>
    <v-card flat class="overflow-y-auto" style="height: 100%">
        <v-card-title class="text-subtitle-1">
            Version history
            <v-spacer></v-spacer>
            <v-chip v-if="lockState.locked" small color="green" dark>
                <v-icon left small>mdi-lock</v-icon>
                accepted &amp; locked
            </v-chip>
            <v-chip v-else small color="grey lighten-1">
                <v-icon left small>mdi-lock-open-variant</v-icon>
                mutable
            </v-chip>
        </v-card-title>

        <v-card-subtitle v-if="lockState.locked" class="pt-0">
            Locked content hash:
            <code>{{ shortSha(lockState.acceptedSha) }}</code>
        </v-card-subtitle>

        <v-alert v-if="error" type="error" dense outlined class="mx-4">{{ error }}</v-alert>

        <v-progress-linear v-if="loading" indeterminate></v-progress-linear>

        <v-list two-line dense>
            <v-list-item v-for="version in versions" :key="version.commitSha" @click="selectVersion(version)">
                <v-list-item-icon>
                    <v-icon :color="version.commitSha === selected?.commitSha ? 'primary' : ''">
                        mdi-source-commit
                    </v-icon>
                </v-list-item-icon>
                <v-list-item-content>
                    <v-list-item-title>{{ version.message }}</v-list-item-title>
                    <v-list-item-subtitle>
                        {{ version.author }} · {{ formatDate(version.date) }} · commit
                        <code>{{ shortSha(version.commitSha) }}</code>
                    </v-list-item-subtitle>
                </v-list-item-content>
            </v-list-item>
            <v-list-item v-if="!loading && versions.length === 0">
                <v-list-item-content>
                    <v-list-item-subtitle>
                        No history yet. The first commit that touches this ADR will appear here.
                    </v-list-item-subtitle>
                </v-list-item-content>
            </v-list-item>
        </v-list>

        <v-divider v-if="selected"></v-divider>

        <v-card-text v-if="selected">
            <div class="d-flex align-center mb-2">
                <strong class="mr-2">Content hash (Git blob SHA):</strong>
                <code>{{ selected.blobSha || "…" }}</code>
                <v-chip
                    v-if="selected.verified !== null"
                    class="ml-2"
                    x-small
                    :color="selected.verified ? 'green' : 'red'"
                    dark
                >
                    {{ selected.verified ? "matches lock" : "differs from lock" }}
                </v-chip>
            </div>
            <pre class="version-content">{{ selected.content }}</pre>
        </v-card-text>
    </v-card>
</template>

<script>
import { store } from "/src/plugins/store";
import { loadFileCommitHistory, loadRawFileAtRef } from "/src/plugins/api";
import { gitBlobSha, verifyContentHash } from "/src/plugins/cas";

export default {
    name: "EditorVersionHistory",
    data: () => ({
        versions: [],
        selected: null,
        loading: false,
        error: "",
        lockState: { locked: false, acceptedSha: null }
    }),
    created() {
        this.refresh();
        store.$on("open-adr", this.refresh);
    },
    beforeDestroy() {
        store.$off("open-adr", this.refresh);
    },
    methods: {
        async refresh() {
            this.versions = [];
            this.selected = null;
            this.error = "";
            const repo = store.currentRepository;
            const adr = store.currentlyEditedAdr;
            if (!repo || !adr) {
                return;
            }
            this.lockState = store.getLockState ? store.getLockState(adr) : { locked: false, acceptedSha: null };
            this.loading = true;
            try {
                const commits = await loadFileCommitHistory(repo.fullName, repo.activeBranch, adr.path);
                this.versions = (commits || []).map((c) => ({
                    commitSha: c.sha,
                    message: (c.commit && c.commit.message ? c.commit.message : "").split("\n")[0],
                    author: c.commit && c.commit.author ? c.commit.author.name : "unknown",
                    date: c.commit && c.commit.author ? c.commit.author.date : null,
                    blobSha: null,
                    content: null,
                    verified: null
                }));
            } catch (e) {
                this.error = "Could not load history: " + e.message;
            } finally {
                this.loading = false;
            }
        },
        async selectVersion(version) {
            this.selected = version;
            if (version.content !== null) {
                return;
            }
            const repo = store.currentRepository;
            try {
                const content = await loadRawFileAtRef(repo.fullName, version.commitSha, store.currentlyEditedAdr.path);
                version.content = content;
                version.blobSha = await gitBlobSha(content);
                version.verified = this.lockState.acceptedSha
                    ? await verifyContentHash(content, this.lockState.acceptedSha)
                    : null;
            } catch (e) {
                this.error = "Could not load version content: " + e.message;
            }
        },
        shortSha(sha) {
            return sha ? sha.substring(0, 10) : "";
        },
        formatDate(date) {
            return date ? new Date(date).toLocaleString() : "";
        }
    }
};
</script>

<style scoped>
.version-content {
    white-space: pre-wrap;
    word-break: break-word;
    background: rgba(0, 0, 0, 0.04);
    padding: 8px;
    border-radius: 4px;
    max-height: 40vh;
    overflow-y: auto;
}
</style>
