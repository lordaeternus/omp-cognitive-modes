# OMP Cognitive Modes

Extensão para [Oh My Pi](https://github.com/can1357/oh-my-pi) que adiciona dois modos cognitivos independentes ao agente:

- `🧠 Pensar [Ativo]`: aumenta o raciocínio e aplica uma disciplina leve de reflexão, evidência e revisão final.
- `🚀 Boost [Ativo]`: organiza trabalhos complexos em investigação, planejamento, execução e verificação.

Os dois modos podem permanecer ativos simultaneamente. Ligar ou desligar um não altera o outro.

## Requisitos

- Node.js 22.19 ou superior
- Oh My Pi com suporte a extensões TypeScript

## Instalação

Copie `pensar.ts` para a pasta global de extensões do OMP:

### Windows

```powershell
New-Item -ItemType Directory -Force "$HOME\.omp\agent\extensions"
Copy-Item .\pensar.ts "$HOME\.omp\agent\extensions\pensar.ts"
```

### Linux e macOS

```bash
mkdir -p ~/.omp/agent/extensions
cp pensar.ts ~/.omp/agent/extensions/pensar.ts
```

Se o OMP já estiver aberto, execute `/reload` ou reinicie-o.

Também é possível carregar a extensão diretamente:

```bash
omp -e ./pensar.ts
```

## Uso

### Pensar

Digite `/pensar` para ligar ou desligar:

```text
/pensar
```

Com o modo ativo, o agente:

1. entende objetivo e restrições antes de agir;
2. questiona a primeira conclusão quando existe ambiguidade relevante;
3. verifica evidências antes de afirmar;
4. revisa silenciosamente a resposta antes de entregá-la.

Também aceita comandos explícitos e uma tarefa pontual:

```text
/pensar on
/pensar off
/pensar investigue e corrija este erro
```

Em modelos com raciocínio nativo, usa o maior nível suportado. Em outros modelos, habilita a ferramenta estruturada `think`.

### Boost

Digite `/boost` para ligar ou desligar:

```text
/boost
```

O modo organiza a execução em quatro etapas:

1. investigação;
2. planejamento;
3. execução cirúrgica;
4. verificação e auditoria.

Também aceita comandos explícitos e uma tarefa pontual:

```text
/boost on
/boost off
/boost revise este módulo e corrija os problemas encontrados
```

### Usar os dois juntos

```text
/pensar
/boost
```

A barra de status mostrará os dois indicadores. Nesse estado, Pensar melhora o processo de raciocínio e Boost estrutura a execução.

## Segurança

A extensão aplica guardrails contra alterações prematuras: arquivos existentes precisam ser investigados com sucesso antes de serem modificados. Resultados de ferramentas e subagentes são correlacionados antes de liberar mutações.

A extensão não contém chaves, tokens ou credenciais.

## Desenvolvimento

```bash
npm install
npm run typecheck
```

O código dos dois comandos está reunido em `pensar.ts`, pois eles compartilham estado cognitivo, integração com modelos e guardrails.
