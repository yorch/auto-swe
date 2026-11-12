{{/* Names */}}
{{- define "auto-swe.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "auto-swe.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component: (dict "ctx" $ "component" "gateway") */}}
{{- define "auto-swe.selectorLabels" -}}
app.kubernetes.io/name: {{ .ctx.Chart.Name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Image reference for one component; a digest wins over the tag. */}}
{{- define "auto-swe.image" -}}
{{- $img := index .ctx.Values.image .component -}}
{{- $repo := printf "%s/%s" .ctx.Values.image.registry $img.repository -}}
{{- if $img.digest -}}
{{- printf "%s@%s" $repo $img.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (.ctx.Values.image.tag | default .ctx.Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{- define "auto-swe.secretName" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-secrets" (include "auto-swe.fullname" .)) -}}
{{- end -}}

{{- define "auto-swe.workerServiceAccount" -}}
{{- .Values.worker.serviceAccount.name | default (printf "%s-worker" (include "auto-swe.fullname" .)) -}}
{{- end -}}

{{- define "auto-swe.gatewayInternalUrl" -}}
{{- printf "http://%s-gateway.%s.svc:%v" (include "auto-swe.fullname" .) .Release.Namespace .Values.service.gatewayPort -}}
{{- end -}}

{{/* The Service workspace pods reach the worker's proxies through. */}}
{{- define "auto-swe.workerProxyHost" -}}
{{- printf "%s-worker-proxy.%s.svc" (include "auto-swe.fullname" .) .Release.Namespace -}}
{{- end -}}

{{/* Required values, checked once, wherever the chart renders. */}}
{{- define "auto-swe.validate" -}}
{{- $_ := required "urls.api is required (the gateway's public URL)" .Values.urls.api -}}
{{- $_ := required "urls.web is required (the dashboard's public URL)" .Values.urls.web -}}
{{- $_ := required "temporal.address is required (host:port of the Temporal frontend)" .Values.temporal.address -}}
{{- if not .Values.secrets.existingSecret -}}
{{- range $key := list "DATABASE_URL" "CONFIG_ENCRYPTION_KEY" "BETTER_AUTH_SECRET" "JWT_SECRET" -}}
{{- $_ := required (printf "secrets.values.%s is required when secrets.existingSecret is empty" $key) (index $.Values.secrets.values $key) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.worker.enabled (not .Values.worker.proxies.modelPort) -}}
{{- fail "worker.proxies.modelPort is required: the Kubernetes workspace backend refuses to start without the model proxy" -}}
{{- end -}}
{{- if and .Values.worker.enabled (or .Values.workspaces.requireRuntimeClass .Values.workspaces.kataRuntimeClass.create) (not .Values.workspaces.runtimeClassName) -}}
{{- fail "workspaces.runtimeClassName is required when requiring a RuntimeClass or creating a Kata RuntimeClass" -}}
{{- end -}}
{{- end -}}

{{/* Env shared by the gateway and the worker. */}}
{{- define "auto-swe.serverEnvFrom" -}}
- configMapRef:
    name: {{ include "auto-swe.fullname" . }}-config
- secretRef:
    name: {{ include "auto-swe.secretName" . }}
{{- end -}}

{{/* Artifact-store volume, when a filesystem claim is configured. */}}
{{- define "auto-swe.artifactVolume" -}}
{{- if .Values.config.artifacts.fs.existingClaim }}
- name: artifacts
  persistentVolumeClaim:
    claimName: {{ .Values.config.artifacts.fs.existingClaim }}
{{- end }}
{{- end -}}
