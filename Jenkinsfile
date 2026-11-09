pipeline {
    agent any

    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds()
    }

    environment {
        // Images are <RCAB_REGISTRY>/rcab-api:<commit sha> and rcab-web:<commit sha>
        // (the names docker-compose.prod.yml pulls). Release flow: scripts/deploy/.
        RCAB_REGISTRY = 'ghcr.io/logicthread'
        // Jenkins job/folder environment (not in this file):
        //   NEXT_PUBLIC_*   public browser config inlined into the web image
        //   PROD_API_URL    public https URL of the API on the VPS (default https://$PROD_HOST)
        //   PROD_WEB_URL    optional public web URL; also asserted via /version.json
        // Credentials: ghcr-pat, vps-ssh-key, vps-known-hosts, vps-host (= PROD_HOST).
    }

    stages {
        stage('Install') {
            steps {
                sh 'pnpm install --frozen-lockfile'
            }
        }

        stage('Lint') {
            steps {
                sh 'pnpm lint'
                // docs/POLICY.md + api.env.example policy block are generated from
                // the business policy schema (RCAB-E8.S10); fail on drift.
                sh 'pnpm policy:doc:check'
                // The repo root has no tsconfig, so a root-level `tsc --noEmit` checks
                // nothing. Type-check every workspace package instead; workspace
                // libs are built first because the api/web resolve them via dist/.
                sh 'pnpm --filter @rcab/shared --filter @rcab/api-client build'
                sh 'pnpm -r exec tsc --noEmit'
            }
        }

        stage('API artifact') {
            steps {
                // Production build must ship the Lua assets and the compiled
                // services must be able to read them; dev loader must inject.
                sh 'pnpm --filter @rcab/api run test:artifact'
                sh 'pnpm --filter @rcab/api run test:dev-loader'
            }
        }

        stage('Unit tests') {
            steps {
                // API unit run enforces the coverage floor (vitest thresholds);
                // web keeps its plain unit run.
                sh 'pnpm --filter @rcab/api run test:cov'
                sh 'pnpm --filter @rcab/web run test'
                sh 'pnpm test:probe'
            }
        }

        stage('System probe smoke') {
            steps {
                // Non-interactive: no installs, no k6, emits host + dep report only
                sh 'pnpm system:probe --ci'
                sh 'test -f system-probe-report.json'
                sh 'node -e "const r = JSON.parse(require(\'fs\').readFileSync(\'system-probe-report.json\')); if (!r.host) process.exit(1);"'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'system-probe-report.json', allowEmptyArchive: true
                }
            }
        }

        stage('Integration tests') {
            steps {
                // Testcontainers spins up postgres + redis internally — Docker socket must be mounted
                sh 'pnpm test:int'
            }
        }

        stage('Build images') {
            steps {
                // Build API + web ONCE for this commit (RCAB-E8.S11). Tagged with the
                // commit SHA only (no mutable `latest`); the SHA is also baked in as
                // build args so the running service reports it. NEXT_PUBLIC_* are
                // inlined at build time: define them as Jenkins job/folder environment
                // variables (public values only). The web Dockerfile fails the build
                // when a required one is empty.
                sh 'bash scripts/deploy/build-images.sh --version "$GIT_COMMIT" --registry "$RCAB_REGISTRY"'
            }
        }

        stage('Image identity check') {
            steps {
                // The artifact we are about to publish must carry the identity we
                // intend to deploy: OCI revision label, and the version the api
                // process itself will report at /v1/health/version.
                sh '''
                    set -eu
                    for img in rcab-api rcab-web; do
                        rev="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$RCAB_REGISTRY/$img:$GIT_COMMIT")"
                        test "$rev" = "$GIT_COMMIT" || { echo "$img revision label '$rev' != $GIT_COMMIT"; exit 1; }
                    done
                    ver="$(docker run --rm --entrypoint node "$RCAB_REGISTRY/rcab-api:$GIT_COMMIT" -p 'process.env.RCAB_VERSION')"
                    test "$ver" = "$GIT_COMMIT" || { echo "api image reports version '$ver' != $GIT_COMMIT"; exit 1; }
                    wver="$(docker run --rm --entrypoint cat "$RCAB_REGISTRY/rcab-web:$GIT_COMMIT" /app/public/version.json)"
                    case "$wver" in *"\\"$GIT_COMMIT\\""*) ;; *) echo "web version.json '$wver' lacks $GIT_COMMIT"; exit 1;; esac
                '''
            }
        }

        stage('Push to GHCR') {
            when {
                anyOf {
                    branch 'main'
                    branch pattern: 'release/.*', comparator: 'REGEXP'
                }
            }
            steps {
                withCredentials([string(credentialsId: 'ghcr-pat', variable: 'GHCR_TOKEN')]) {
                    sh '''
                        set -eu
                        echo "$GHCR_TOKEN" | docker login ghcr.io -u logicthread --password-stdin
                        docker push "$RCAB_REGISTRY/rcab-api:$GIT_COMMIT"
                        docker push "$RCAB_REGISTRY/rcab-web:$GIT_COMMIT"
                        # Release manifest: the immutable identities that were published.
                        api_digest="$(docker image inspect --format '{{ index .RepoDigests 0 }}' "$RCAB_REGISTRY/rcab-api:$GIT_COMMIT")"
                        web_digest="$(docker image inspect --format '{{ index .RepoDigests 0 }}' "$RCAB_REGISTRY/rcab-web:$GIT_COMMIT")"
                        printf '{"version":"%s","api":"%s","web":"%s","publishedAt":"%s"}\\n' \\
                            "$GIT_COMMIT" "$api_digest" "$web_digest" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > release-manifest.json
                        cat release-manifest.json
                        docker logout ghcr.io
                    '''
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'release-manifest.json', allowEmptyArchive: true
                }
            }
        }

        stage('Deploy to staging') {
            when {
                anyOf {
                    branch 'main'
                    branch pattern: 'release/.*', comparator: 'REGEXP'
                }
            }
            input {
                message 'Deploy to staging?'
                ok 'Deploy'
                submitterParameter 'DEPLOY_APPROVER'
            }
            steps {
                // deploy.sh (RCAB-E8.S11): records the previous version, ships infra/,
                // pulls THIS commit's images, runs the migrator as a one-shot, starts
                // api+web, then verifies the real target (PROD_API_URL, default
                // https://$PROD_HOST) is ready AND reports version == $GIT_COMMIT. On a
                // failed verification it rolls back to the previous SHA and the stage
                // still FAILS (exit 10/11): a rolled-back release is not a green build.
                // Host key is pinned via the vps-known-hosts file credential.
                withCredentials([
                    sshUserPrivateKey(
                        credentialsId:  'vps-ssh-key',
                        keyFileVariable:  'SSH_KEY',
                        usernameVariable: 'SSH_USER'
                    ),
                    file(credentialsId: 'vps-known-hosts', variable: 'KNOWN_HOSTS'),
                    string(credentialsId: 'vps-host', variable: 'PROD_HOST')
                ]) {
                    sh '''
                        set -eu
                        API_URL="${PROD_API_URL:-https://$PROD_HOST}"
                        bash scripts/deploy/deploy.sh \\
                            --version "$GIT_COMMIT" \\
                            --remote "$SSH_USER@$PROD_HOST" \\
                            --ssh-key "$SSH_KEY" \\
                            --known-hosts "$KNOWN_HOSTS" \\
                            --sync-infra \\
                            --api-url "$API_URL" \\
                            ${PROD_WEB_URL:+--web-url "$PROD_WEB_URL"} \\
                            --timeout 180
                    '''
                }
            }
        }
    }

    post {
        always {
            cleanWs()
        }
        failure {
            echo "Pipeline FAILED — branch: ${env.BRANCH_NAME}, build: ${env.BUILD_URL}"
        }
        success {
            echo "Pipeline passed — ${env.BRANCH_NAME} @ ${env.GIT_COMMIT}"
        }
    }
}
