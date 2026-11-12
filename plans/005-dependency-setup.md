# Lot 005 — Installer les dépendances une fois par job

Priorité P2 ; effort S–M ; risque faible ; aucune dépendance logique. Appliquer après 001 sur les fichiers partagés. Préparé le 12 novembre 2026 au commit local `574463d37ff590b8f9d9c44f898b466409b78032`, comparé au main `a9f0778229e230502f9c9fe9bd20bcd4c029a692`.

## But et état actuel

L’action `.github/actions/setup-environment/action.yml` installe les dépendances, puis chaque appel Make recommence et exécute `pnpm add -D tsx`, alors que tsx est déjà déclaré dans package.json. Le run Claims invoque plusieurs Makefiles dans le même job. C’est un coût secondaire, mais partagé dans le dépôt, et une source de mutation du lockfile.

```make
# automation/indexer.mk ; motif présent dans dix Makefiles
install-deps:
	@echo "Installing dependencies..."
	@$(PNPM) install
	@$(PNPM) add -D tsx
```

Sur main observé, l’action et les fichiers setup utilisent Node 22.23.4 et Python 3.12.15 ; le chemin nodeenv est versionné. Ne pas revenir aux anciennes valeurs du checkout local. L’action propose déjà `install-deps` et `frozen-lockfile`, ce dernier actuellement faux par défaut. Utiliser ces points d’entrée, pas un deuxième système d’installation.

## Périmètre

Action `.github/actions/setup-environment/action.yml`, `automation/setup/node.mk`, les dix Makefiles suivants et uniquement les workflows dont les commandes nécessitent une adaptation :

- `automation/indexer.mk`, `automation/weekly-bounties.mk`, `automation/distribution.mk`, `automation/reports.mk`, `automation/compute-apr.mk`.
- `automation/metadata.mk`, `automation/sdtokens-verify.mk`, `automation/sdfxs/run.mk`, `automation/spectra/run.mk`, `automation/vlCVX/votium.mk`.
- `.github/workflows/*.yaml` : modifier seulement les appels setup/Make ; ne pas toucher aux schedules, notifications, certificats, permissions, calculs ou étapes de publication.

package.json et pnpm-lock.yaml ne doivent pas changer. Si leur incohérence actuelle empêche un install frozen, établir la preuve et proposer un lot séparé avant de poursuivre. Les anomalies de cibles Make sans rapport avec l’installation restent hors périmètre.

Dérive : `git diff --stat 574463d37ff590b8f9d9c44f898b466409b78032..HEAD -- automation .github/actions/setup-environment .github/workflows` puis diff non committé. Les changements runtime/CA sur main et le lot 001 sont attendus.

## Exécution et contrôles

1. Inventorier les jobs et leurs commandes via `rg -n 'setup-environment|make -f|pnpm install|setup-node' .github/workflows .github/actions automation`. Pour chacun, noter qui installe et quel exécutable pnpm il utilise. L’action composite et Make utilisent aujourd’hui des environnements Node différents ; supprimer une installation sans vérifier ce point serait insuffisant.
2. Supprimer les dix `pnpm add -D tsx`. Garder les commandes locales Make autonomes : sans option CI, elles préparent leur environnement et installent avec le lockfile. Une exécution locale depuis un worktree sans node_modules reste supportée.
3. Introduire un seul mode explicite pour les jobs ayant déjà effectué le setup, par exemple `CI_SETUP_DONE=1`, partagé via `automation/setup/node.mk`. Dans ce mode, utiliser les exécutables Node/pnpm déjà préparés par l’action et sauter setup/install Make, sans se fier seulement à la présence du répertoire node_modules. Propager ce mode uniquement aux jobs effectivement préparés ; les workflows anciens sans setup gardent le chemin autonome. Ne pas supprimer les cibles setup ou clean requises par ces workflows.
4. Utiliser une installation frozen dans l’action après confirmation sur worktree propre. Ajouter le cache du store pnpm via l’action existante, avec clé tenant compte de l’OS et du lockfile. Si setup-node exige pnpm pour résoudre le store, installer pnpm avant sa configuration de cache. Ne pas cacher node_modules comme une preuve d’installation valide. Préserver les versions runtime et les protections CA courantes.
5. Dans les jobs multi-Make, confirmer une seule installation initiale et aucune installation par cible. Dans les jobs sans action commune, soit conserver un seul setup autonome, soit adopter l’action existante si cela évite une duplication réelle ; ne pas réécrire des pipelines entiers pour uniformiser leur apparence.

## Vérification

- `rg -n 'PNPM\) add -D tsx|pnpm add -D tsx' automation .github` : aucun résultat. `git diff --exit-code -- package.json pnpm-lock.yaml` : pas de changement de ce lot.
- Utiliser `make -n -f automation/indexer.mk get-delegators CI_SETUP_DONE=1`, `make -n -f automation/weekly-bounties.mk run-convex-votium CI_SETUP_DONE=1`, `make -n -f automation/distribution.mk run-merkles PROTOCOL=vlCVX CI_SETUP_DONE=1`, puis les cibles publiques des autres Makefiles : pas de nodeenv, install ou add dans le mode déjà préparé. Les mêmes dry-runs sans option gardent le setup local. Ne pas utiliser les cibles commit/push/clean pour ce contrôle.
- Valider le YAML selon les outils déjà disponibles et comparer la matrice job → setup → commandes. Pour une preuve exécutable hors production, utiliser un worktree jetable et un shim pnpm qui enregistre les invocations et remplace les scripts financiers par un succès sans réseau : deux cibles après setup doivent compter une seule installation, aucune commande add et les mêmes arguments de script. Supprimer le shim après validation.
- `pnpm install --frozen-lockfile` puis `pnpm test:unit` dans le worktree propre : installation réussie sans mutation du manifeste/lockfile ; tests concernés verts. Cette installation fait partie de l’exécution future, pas de la préparation du plan.

## Critères, arrêt et retour arrière

- [ ] Zéro installation dynamique de tsx ; manifeste/lockfile inchangés.
- [ ] Une installation par job préparé, démontrée sur plusieurs cibles Make.
- [ ] Les commandes locales autonomes et les jobs sans action setup restent fonctionnels.
- [ ] Le cache fonctionne sur hit comme sur miss et ne remplace pas l’installation frozen.
- [ ] Aucun schedule, niveau de permission ni comportement de publication n’a changé.

Arrêter si une commande requiert un runtime différent de celui préparé ou si la baseline frozen échoue. Ne pas augmenter les versions ni régénérer le lockfile au passage. Revert du mode setup et des workflows affectés possible sans migration de données.

## Clôture à remplir

Implémenté dans l’action, `node.mk`, les dix Makefiles et quatre workflows préparés : Claims, Reports, sdTokens Merkle, vlCVX Distribution. `CI_SETUP_DONE=1` emploie le PATH préparé sans setup/install Make ; sans option, setup local et frozen install conservés. Dix `add -D tsx` supprimés. Cache store pnpm avant installation frozen par défaut ; versions/CA/gates/schedules/permissions préservés. L’override explicite non-frozen de Compute APR est resté inchangé, hors adaptation des workflows Make : il ne bénéficie donc pas du frozen par défaut.

Dry-runs CI/locaux sur dix Makefiles ; exécution isolée par shim : une installation frozen, quinze appels tsx neutralisés, zéro add, arguments conservés. Manifeste/lockfile inchangés. Test Make existant : 25 verts. Cache hit/miss GitHub non observé localement ; l’installation reste exécutée indépendamment d’un cache hit. Voir [le journal](EXECUTION.md) et l’état CI du SHA livré.
