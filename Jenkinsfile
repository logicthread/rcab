pipeline {
    agent any

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
    }

    environment {
        IMAGE_API = 'ghcr.io/logicthread/rcab/api'
        IMAGE_WEB = 'ghcr.io/logicthread/rcab/web'
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
                sh """
                    docker build \\
                        -f infra/docker/api/Dockerfile.prod \\
                        -t ${IMAGE_API}:${env.GIT_COMMIT} \\
                        -t ${IMAGE_API}:latest \\
                        .
                    # NEXT_PUBLIC_* are inlined at build time: define them as Jenkins
                    # job/folder environment variables (public values only). The
                    # Dockerfile fails the build when a required one is empty.
                    docker build \\
                        --build-arg NEXT_PUBLIC_API_URL="\$NEXT_PUBLIC_API_URL" \\
                        --build-arg NEXT_PUBLIC_FIREBASE_API_KEY="\$NEXT_PUBLIC_FIREBASE_API_KEY" \\
                        --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="\$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN" \\
                        --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID="\$NEXT_PUBLIC_FIREBASE_PROJECT_ID" \\
                        --build-arg NEXT_PUBLIC_FIREBASE_APP_ID="\$NEXT_PUBLIC_FIREBASE_APP_ID" \\
                        --build-arg NEXT_PUBLIC_NOMINATIM_URL="\${NEXT_PUBLIC_NOMINATIM_URL:-https://nominatim.openstreetmap.org}" \\
                        -f infra/docker/web/Dockerfile.prod \\
                        -t ${IMAGE_WEB}:${env.GIT_COMMIT} \\
                        -t ${IMAGE_WEB}:latest \\
                        .
                """
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
                    sh """
                        echo "\$GHCR_TOKEN" | docker login ghcr.io -u logicthread --password-stdin
                        docker push ${IMAGE_API}:${env.GIT_COMMIT}
                        docker push ${IMAGE_API}:latest
                        docker push ${IMAGE_WEB}:${env.GIT_COMMIT}
                        docker push ${IMAGE_WEB}:latest
                    """
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
                withCredentials([
                    sshUserPrivateKey(
                        credentialsId: 'vps-ssh-key',
                        keyFileVariable:  'SSH_KEY',
                        usernameVariable: 'SSH_USER'
                    ),
                    string(credentialsId: 'vps-host', variable: 'VPS_HOST')
                ]) {
                    sh """
                        ssh -i "\$SSH_KEY" -o StrictHostKeyChecking=no "\$SSH_USER@\$VPS_HOST" '
                            set -e
                            cd /opt/rcab/compose
                            docker compose pull
                            docker compose up -d
                        '
                    """
                }
                sh 'bash scripts/prod-smoke.sh'
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
