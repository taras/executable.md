<WhenPrompt template="{?before}Write an executable Markdown document that does this:{?rest}" />

DRAFT

<Loop max={12}>
<WhenPrompt template="{?before}That draft is not right yet:{?feedback}" />

DRAFT
</Loop>
