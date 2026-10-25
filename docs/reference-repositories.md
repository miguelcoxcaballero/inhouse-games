# Referencias de Inhouse consultadas

Inspección realizada el 25 de octubre de 2026 para la implementación original de **inhouse link**.

## Alcance de la descarga

Se enumeraron las páginas públicas de la cuenta [miguelcoxcaballero](https://github.com/miguelcoxcaballero?tab=repositories): 30 repositorios en la primera página, 11 en la segunda y ninguno en la tercera. Se descargaron **los 41 repositorios públicos visibles**, sin fallos, como clones superficiales de su rama predeterminada en `/workspace/inhouse-reference/<repositorio>`. Se comprobaron el commit local y el estado limpio de cada copia. No se ejecutaron sus aplicaciones ni se modificaron sus archivos.

La API autenticada de GitHub no era accesible desde la política de red de esta máquina (`api.github.com`, denegación CONNECT 403). Por ello, esta lista no establece que se hayan podido descubrir o descargar repositorios privados de la cuenta. No se solicitaron ni extrajeron credenciales y no se cambió la política de red.

Las copias son referencias locales; no son dependencias de inhouse link y no necesitan publicarse con su aplicación. No se ha copiado lógica, componentes ni código de streaming desde estos proyectos o desde los programas comparados. La implementación usa los rasgos visuales de la marca del usuario como referencia.

## Identidad visual comprobada

La referencia principal es el documento ya existente [`inhousenotes/inhouse-identity-kit.html`](https://github.com/miguelcoxcaballero/inhousenotes/blob/6b266db8ad72703908e26ecd07d9e56f8777ce8a/inhouse-identity-kit.html), corroborado con los estilos de Software, Notes, Read, Jobs y Vidmaker.

| Elemento | Regla observada |
|---|---|
| Nombre de producto | Minúsculas: `inhouse link`, siguiendo `inhouse notes` y `inhouse read`. |
| Marca raíz | Negro `#000000`, cobre `#d97736`, crema `#f5f5f0`. |
| Acento de aplicaciones | Naranja `#E07A3C`; las aplicaciones pueden incorporar un acento de producto propio. |
| Tipografía | Comfortaa para marca y titulares; DM Sans para interfaz y cuerpo. El sitio raíz también usa Lato. |
| Símbolo | Tejado lineal sencillo, con extremos y uniones redondeados. |
| Tema claro | Fondo crema `#f5f5f0`, superficies blancas, texto `#1a1a1a`. |
| Tema oscuro de aplicaciones | Fondo `#151515`, superficies `#1c1c1c`, texto `#f5f5f5`, bordes blancos al 8 %. |
| Geometría | Controles y tarjetas redondeados; radios habituales 8–28 px, píldoras completas y objetivos táctiles de unos 44 px. |
| Tratamiento | Sombras discretas, separación amplia, bordes suaves, iconos lineales y estados de interacción explícitos. |

Para el escritorio de juegos se tomó la variante oscura de la familia, manteniendo la tipografía, el acento cálido y el tejado de la marca. No se inventó una identidad verde/lima como sustituto.

Hay fuentes offline de Comfortaa y DM Sans con licencias OFL en Notes y Read. Si se distribuyen fuentes, deben conservarse sus avisos de licencia; no es necesario depender de Google Fonts durante una sesión remota.

## Inventario descargado

El commit identifica la copia revisada, no una promesa de que sea la última revisión futura. La inspección visual fue más detallada en los repositorios de identidad y en las aplicaciones Inhouse; los demás se revisaron por README, estructura y archivos de interfaz disponibles.

| Repositorio | Commit revisado | Revisión |
|---|---|---|
| [Inhouse-Photos](https://github.com/miguelcoxcaballero/Inhouse-Photos) | `e2c07e97645f` | Estilos de app web y portal; variante cálida. |
| [Inhouse-Photos-Site](https://github.com/miguelcoxcaballero/Inhouse-Photos-Site) | `beb5df20fd5d` | Página de producto y paleta cálida. |
| [Inhouse-battery-check](https://github.com/miguelcoxcaballero/Inhouse-battery-check) | `6efd0ec7eac9` | README, estructura y archivos de interfaz disponibles. |
| [RendezPlan](https://github.com/miguelcoxcaballero/RendezPlan) | `91224d96e1a4` | README, estructura y archivos de interfaz disponibles. |
| [TypeTest](https://github.com/miguelcoxcaballero/TypeTest) | `33f39772b0e9` | README, estructura y archivos de interfaz disponibles. |
| [antenahechaamano](https://github.com/miguelcoxcaballero/antenahechaamano) | `eb9021e682da` | README, estructura y archivos de interfaz disponibles. |
| [creaciondeundronautonomo](https://github.com/miguelcoxcaballero/creaciondeundronautonomo) | `dc2d09ac823c` | README, estructura y archivos de interfaz disponibles. |
| [diario](https://github.com/miguelcoxcaballero/diario) | `bf29e9bc5f04` | README, estructura y archivos de interfaz disponibles. |
| [eggtimer](https://github.com/miguelcoxcaballero/eggtimer) | `87923ab68ae1` | README, estructura y archivos de interfaz disponibles. |
| [greylock-radio](https://github.com/miguelcoxcaballero/greylock-radio) | `d488622919eb` | README, estructura y archivos de interfaz disponibles. |
| [home](https://github.com/miguelcoxcaballero/home) | `3302ecdce05a` | Sitio personal; contraste con la identidad Inhouse. |
| [ig-calma](https://github.com/miguelcoxcaballero/ig-calma) | `f91156bcf588` | Proyecto del ecosistema; recursos de marca. |
| [inhouse-apkbuilder](https://github.com/miguelcoxcaballero/inhouse-apkbuilder) | `fbeaf0f0d515` | README, estructura y archivos de interfaz disponibles. |
| [inhouse-cook](https://github.com/miguelcoxcaballero/inhouse-cook) | `5cde8c29e204` | Paleta, tipografía y variante de producto. |
| [inhouse-games](https://github.com/miguelcoxcaballero/inhouse-games) | `da0a19617358` | README, estructura y archivos de interfaz disponibles. |
| [inhouse-jobs](https://github.com/miguelcoxcaballero/inhouse-jobs) | `b019635de7af` | Tema oscuro, superficies, espaciado y componentes. |
| [inhouse-math-playground](https://github.com/miguelcoxcaballero/inhouse-math-playground) | `2ada076b3a8b` | Tipografía compartida y acento azul propio. |
| [inhouse-read](https://github.com/miguelcoxcaballero/inhouse-read) | `fa590de626d6` | Tokens compartidos, tipografía y variantes de producto. |
| [inhouse-services-updater](https://github.com/miguelcoxcaballero/inhouse-services-updater) | `d0d2afdd8b29` | Herramienta común; inspección de CSS. |
| [inhouse-software](https://github.com/miguelcoxcaballero/inhouse-software) | `2e68e19fbacc` | Marca raíz y catálogo; tokens, tipografía y logotipo. |
| [inhouse-vidmaker](https://github.com/miguelcoxcaballero/inhouse-vidmaker) | `ef95530dda16` | Aplicación multimedia; tema oscuro y controles. |
| [inhouselearn](https://github.com/miguelcoxcaballero/inhouselearn) | `667784e2fdb5` | Tipografía de familia y estilos de aprendizaje. |
| [inhousemusic](https://github.com/miguelcoxcaballero/inhousemusic) | `c4b7ab3e5da1` | README, estructura y archivos de interfaz disponibles. |
| [inhousenotes](https://github.com/miguelcoxcaballero/inhousenotes) | `6b266db8ad72` | Kit de identidad explícito y tema claro/oscuro. |
| [keyboardPractice](https://github.com/miguelcoxcaballero/keyboardPractice) | `fda52a0b10e0` | README, estructura y archivos de interfaz disponibles. |
| [loskelvin](https://github.com/miguelcoxcaballero/loskelvin) | `e477ce3df2c0` | README, estructura y archivos de interfaz disponibles. |
| [maps](https://github.com/miguelcoxcaballero/maps) | `e217ca36b367` | README, estructura y archivos de interfaz disponibles. |
| [metro-studio](https://github.com/miguelcoxcaballero/metro-studio) | `423bec333510` | README, estructura y archivos de interfaz disponibles. |
| [multiplicar](https://github.com/miguelcoxcaballero/multiplicar) | `1c4ebb013c4d` | README, estructura y archivos de interfaz disponibles. |
| [paellas](https://github.com/miguelcoxcaballero/paellas) | `04da77561681` | README, estructura y archivos de interfaz disponibles. |
| [politraumat](https://github.com/miguelcoxcaballero/politraumat) | `4ff6ceaaa924` | README, estructura y archivos de interfaz disponibles. |
| [pomodoro](https://github.com/miguelcoxcaballero/pomodoro) | `6ab2172310b1` | README, estructura y archivos de interfaz disponibles. |
| [putarenfe](https://github.com/miguelcoxcaballero/putarenfe) | `c0e725d1f591` | README, estructura y archivos de interfaz disponibles. |
| [sakai-nueva-interfaz](https://github.com/miguelcoxcaballero/sakai-nueva-interfaz) | `3ab5f2fe79e0` | README, estructura y archivos de interfaz disponibles. |
| [scan](https://github.com/miguelcoxcaballero/scan) | `6c0cbea106da` | Producto del catálogo; inspección de interfaz. |
| [speedread](https://github.com/miguelcoxcaballero/speedread) | `f5e43289ab11` | README, estructura y archivos de interfaz disponibles. |
| [temario](https://github.com/miguelcoxcaballero/temario) | `b7bd13932c11` | README, estructura y archivos de interfaz disponibles. |
| [timeline](https://github.com/miguelcoxcaballero/timeline) | `c3e729439f0e` | README, estructura y archivos de interfaz disponibles. |
| [winclone](https://github.com/miguelcoxcaballero/winclone) | `328e9a9557e8` | README, estructura y archivos de interfaz disponibles. |
| [wonderxam](https://github.com/miguelcoxcaballero/wonderxam) | `bb2826f0db1d` | README, estructura y archivos de interfaz disponibles. |
| [youtube-calma](https://github.com/miguelcoxcaballero/youtube-calma) | `06192890e2aa` | Proyecto del ecosistema; recursos de marca. |
