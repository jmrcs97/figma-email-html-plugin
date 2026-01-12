# Figma Email HTML Plugin

Esse plugin converte layouts do Figma em HTML baseado em tabelas (`<table>`), otimizado para clientes de e-mail (como Outlook, Gmail, etc). O foco é gerar um código limpo, sem "sujeira" desnecessária, e altamente compatível.

---

## 🚀 Funcionalidades Principais

### 1. Conversão de Layouts (Auto Layout)
O plugin detecta automaticamente o `layoutMode` dos frames do Figma para decidir como montar a estrutura HTML:

*   **Layout Vertical (Stack):**
    *   Gera linhas de tabela (`<tr><td>...</td></tr>`).
    *   **Espaçamento (Gap):** Convertido em células vazias com `height` específico entre os itens.
    *   **Padding:** Convertido em células vazias ou `colspan` inteligente nas bordas.
    *   **Otimização de "Unwrap":** Se um container tem apenas um filho e nenhum estilo relevante (cor, borda), o plugin "remove" o container pai e renderiza o filho diretamente para evitar aninhamento de tabelas desnecessário (`<table>` dentro de `<table>`).

*   **Layout Horizontal:**
    *   Gera células lado a lado na mesma linha (`<tr><td>A</td><td>B</td></tr>`).
    *   **Espaçamento (Gap):** Cria células `<td width="...">` vazias entre os elementos.
    *   **Alinhamento:** Mapeia `align-items` do Figma (Top, Center, Bottom) para `valign="top|middle|bottom"` no HTML.

### 2. Tipografia Limpa e Inteligente
Em vez de envolver cada pedaço de texto em um `<span>`, o plugin usa uma lógica mais esperta:
*   **Detecção de Estilo Base:** Analisa o bloco de texto inteiro e aplica o estilo mais comum (por quantidade de caracteres) diretamente na `<td>` pai.
*   **Spans Mínimos:** Só cria `<span>` para os trechos que **diferem** do estilo base.
*   **Tags Semânticas:** Usa `<strong>` para negrito e `<i>` para itálico, em vez de CSS `font-weight`.
*   **Limpeza de CSS:** Remove declarações padrão inúteis (`font-style: normal`, `text-decoration: none`, `font-weight: 400`). Usa `'bold'` no lugar de `700`.

### 3. Tratamento de Imagens
*   **Detecção Automática:** Além de imagens explícitas, detecta vetores (`VECTOR`, `LINE`) e retângulos com preenchimento de imagem como "elementos de imagem".
*   **Modos de Exportação:**
    *   **Placeholder:** Gera URLs do `placehold.co` com as dimensões exatas (leve e rápido para testar layout).
    *   **Base64:** Exporta o asset real do Figma para PNG e embuta como string Base64 (ideal para demos rápidas autossuficientes).

---

## ⚙️ Configurações

### **Image Export Mode**
*   **Placeholder:** Gera caixas cinzas com o tamanho da imagem.
*   **Base64:** Gera a imagem real.

### **Use Literal Width**
Controla como a largura das tabelas principais é definida:
*   ✅ **Marcado:** Usa a largura fixa em pixels do Figma (ex: `width="600"`). Ideal para layouts rígidos ou elementos internos que não podem esticar.
*   ⬜ **Desmarcado (Padrão):** Gera `width="100%"`. A tabela ocupa todo o espaço disponível do container pai ou da tela. É o comportamento fluido padrão.

---

## 🧠 Detalhes Técnicos "Under the Hood"

### Font Fallbacks
O plugin injeta pilhas de fontes seguras (Web Safe Fonts) automaticamente baseado no nome da fonte usada no Figma:
*   **Inter/Roboto/etc** -> `Arial, Helvetica, sans-serif`
*   **Times/Georgia/etc** -> `'Times New Roman', serif`
*   **Mono** -> `'Courier New', monospace`

### Clean Code
*   **Hex Codes:** Converte cores RGB do Figma para Hexadecimal. Lida com transparência misturando a cor com o fundo (blend), já que e-mails antigos não suportam `rgba`.
*   **Tabelas Limpas:** `cellpadding="0" cellspacing="0" border="0" role="presentation"` são padrão em todas as tabelas para resetar estilos em clientes de e-mail.
*   **Empty Rows:** Linhas de espaçamento vertical usam `font-size: Xpx; line-height: Xpx;` para garantir que o Outlook respeite a altura exata.

---

## 📝 Como Usar
1. Selecione um Frame (ou vários) no Figma.
2. Ajuste as preferências:
    *   **Image Export:** Escolha entre Placeholders (leve) ou Base64 (real).
    *   **Responsiveness:** Marque "Use Literal Width" se quiser larguras fixas em pixels; deixe desmarcado para 100% fluido.
3. Clique em **Convert Selection**.
4. O código aparecerá pronto para copiar.

---

## 🎨 Exemplo de Saída
Veja a limpeza do código gerado para um cartão simples com título, texto e imagem:

```html
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
  <!-- Imagem com largura travada no TD e fluida na TAG -->
  <tr>
    <td width="600" style="width: 600px;" align="center">
      <img src="..." width="600" alt="Hero Image" style="display: block; border: 0; max-width: 600px; height: auto;" />
    </td>
  </tr>
  
  <!-- Espaçamento Vertical (Gap) com Colspan -->
  <tr>
    <td height="24" style="height:24px; font-size:24px; line-height:24px;" colspan="3">&nbsp;</td>
  </tr>

  <!-- Texto com Tipografia Otimizada -->
  <tr>
    <td align="left" style="font-family: Arial, Helvetica, sans-serif; font-size: 16px; color: #333333;">
      Este é um texto <strong>em negrito</strong> e um trecho <i>em itálico</i>.
      O estilo base fica na célula, evitando milhares de &lt;span&gt;.
    </td>
  </tr>
</table>
```