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
                sh 'pnpm exec tsc --noEmit'
            }
        }

        stage('Unit tests') {
            steps {
                sh 'pnpm test'
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
                    docker build \\
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
