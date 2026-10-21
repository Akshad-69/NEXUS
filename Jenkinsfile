#!/usr/bin/env groovy
// ─────────────────────────────────────────────────────────────────────────────
// NEXUS Mission Control — Jenkins pipeline
//
// The real delivery path NEXUS models in its UI:
//
//   checkout → install → typecheck → test → build → images → staging →
//   production approval → production → notify NEXUS
//
// The final stage posts a *signed* webhook back to the control plane
// (POST /api/webhooks/jenkins with X-Nexus-Signature), which is how a build
// shows up in NEXUS as a delivery instead of being typed in by hand. When
// JENKINS_WEBHOOK_SECRET is unset the API skips verification — local mode
// therefore works with zero configuration.
// ─────────────────────────────────────────────────────────────────────────────

pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30', daysToKeepStr: '30'))
    timeout(time: 45, unit: 'MINUTES')
  }

  parameters {
    booleanParam(name: 'DEPLOY_STAGING', defaultValue: true, description: 'Roll the image out to the staging namespace.')
    booleanParam(name: 'DEPLOY_PRODUCTION', defaultValue: false, description: 'After approval, roll the image out to production.')
    string(name: 'NEXUS_API_URL', defaultValue: 'http://127.0.0.1:8787', description: 'Control plane that receives the build result.')
    string(name: 'REGISTRY', defaultValue: 'localhost:5000', description: 'Registry the images are pushed to.')
  }

  environment {
    NEXUS_API_URL = "${params.NEXUS_API_URL}"
    REGISTRY      = "${params.REGISTRY}"
    IMAGE_TAG     = "${env.BRANCH_NAME ?: 'main'}-${env.BUILD_NUMBER}"
    CI            = 'true'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        sh 'node --version && npm --version'
      }
    }

    stage('Install') {
      steps {
        sh 'npm ci --no-audit --no-fund'
      }
    }

    stage('Build shared packages') {
      steps {
        sh 'npm run build:packages'
      }
    }

    stage('Quality gate') {
      parallel {
        stage('Lint & typecheck') {
          steps {
            sh 'npm run lint'
          }
        }
        stage('Unit & integration tests') {
          steps {
            sh 'npm run test'
          }
          post {
            always {
              junit testResults: '**/reports/*.xml', allowEmptyResults: true
            }
          }
        }
      }
    }

    stage('Production build') {
      steps {
        sh 'npm run build'
        archiveArtifacts artifacts: 'apps/web/dist/**', fingerprint: true, allowEmptyArchive: true
      }
    }

    stage('Container images') {
      when { expression { fileExists('apps/api/Dockerfile') } }
      steps {
        sh '''
          set -eu
          docker build -f apps/api/Dockerfile -t "$REGISTRY/nexus-api:$IMAGE_TAG" -t "$REGISTRY/nexus-api:latest" .
          docker build -f apps/web/Dockerfile -t "$REGISTRY/nexus-web:$IMAGE_TAG" -t "$REGISTRY/nexus-web:latest" .
          docker push "$REGISTRY/nexus-api:$IMAGE_TAG"
          docker push "$REGISTRY/nexus-web:$IMAGE_TAG"
        '''
      }
    }

    stage('Deploy — staging') {
      when {
        anyOf {
          expression { return params.DEPLOY_STAGING }
          branch 'main'
        }
      }
      steps {
        sh '''
          set -eu
          kubectl apply -f k8s/nexus.yaml
          kubectl -n nexus set image deployment/nexus-api api="$REGISTRY/nexus-api:$IMAGE_TAG"
          kubectl -n nexus rollout status deployment/nexus-api --timeout=180s
        '''
      }
    }

    stage('Verify staging') {
      when { expression { return params.DEPLOY_STAGING } }
      steps {
        sh '''
          set -eu
          kubectl -n nexus run nexus-smoke --rm -i --restart=Never --image=curlimages/curl:8.10.1 \
            --command -- curl -fsS http://nexus-api/ready
        '''
      }
    }

    stage('Production approval') {
      when { expression { return params.DEPLOY_PRODUCTION } }
      steps {
        timeout(time: 30, unit: 'MINUTES') {
          input message: "Deploy nexus-api:${env.IMAGE_TAG} to production?", ok: 'Deploy to production'
        }
      }
    }

    stage('Deploy — production') {
      when { expression { return params.DEPLOY_PRODUCTION } }
      steps {
        sh '''
          set -eu
          kubectl -n nexus-prod set image deployment/nexus-api api="$REGISTRY/nexus-api:$IMAGE_TAG"
          kubectl -n nexus-prod rollout status deployment/nexus-api --timeout=300s
          # Fail the build if production does not report ready — a rollout that
          # reports success but answers 503 is exactly what this job exists to catch.
          kubectl -n nexus-prod run nexus-verify --rm -i --restart=Never --image=curlimages/curl:8.10.1 \
            --command -- curl -fsS http://nexus-api/ready
        '''
      }
    }
  }

  post {
    success {
      script { notifyNexus('pipeline.completed', 'success') }
    }
    failure {
      script { notifyNexus('pipeline.failed', 'failure') }
    }
    aborted {
      script { notifyNexus('pipeline.failed', 'aborted') }
    }
    always {
      echo "NEXUS image: ${env.REGISTRY}/nexus-api:${env.IMAGE_TAG}"
    }
  }
}

/**
 * Reports the build outcome back to NEXUS.
 *
 * Best-effort by design: a control plane that is down must never fail a build
 * that already shipped. The body is signed with the Jenkins shared secret so
 * the delivery is recorded as verified rather than anonymous.
 */
def notifyNexus(String event, String result) {
  withEnv(["NX_EVENT=${event}", "NX_RESULT=${result}"]) {
    sh '''
      set -eu
      BODY=$(printf '{"event":"%s","provider":"jenkins","job":"%s","build":%s,"result":"%s","image":"%s/nexus-api:%s"}' \
        "$NX_EVENT" "${JOB_NAME:-nexus}" "${BUILD_NUMBER:-0}" "$NX_RESULT" "${REGISTRY:-}" "${IMAGE_TAG:-unknown}")

      SIGNATURE_HEADER=""
      if [ -n "${JENKINS_WEBHOOK_SECRET:-}" ]; then
        SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$JENKINS_WEBHOOK_SECRET" -hex | sed 's/^.*= //')
        SIGNATURE_HEADER="x-nexus-signature: $SIG"
      fi

      curl -fsS --max-time 10 -X POST "${NEXUS_API_URL:-http://127.0.0.1:8787}/api/webhooks/jenkins" \
        -H 'content-type: application/json' \
        -H "x-nexus-event: $NX_EVENT" \
        ${SIGNATURE_HEADER:+-H "$SIGNATURE_HEADER"} \
        --data "$BODY" \
        || echo "::warning::NEXUS control plane unreachable at ${NEXUS_API_URL:-http://127.0.0.1:8787}; build result not recorded."
    '''
  }
}
