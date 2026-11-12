<WhenPrompt as="request" template="{?lead}You are the repository implementor.{?instructions}" model="opus" effort="high" />
<If condition={!["Repository instructions:","Role instructions:","Prepared assignment:","Submission guide:"].every(text => request.instructions.includes(text))}><Fail message="The initial request omitted mandatory instructions, assignment or submission reference." /></If>
<If condition={request.instructions.includes('"$defs"') || request.instructions.includes("Return assessment on completed implementation")}><Fail message="Submission instructions were sent up front." /></If>
initialization received
