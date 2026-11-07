<WhenPrompt as="request" template="{?lead}You are the repository implementor.{?instructions}" model="opus" effort="high" />
<If condition={!["Repository instructions:","Role instructions:","Prepared assignment:",'"$defs"'].every(text => request.instructions.includes(text))}><Fail message="The initial request omitted mandatory instructions, assignment or response schema." /></If>
initialization received
