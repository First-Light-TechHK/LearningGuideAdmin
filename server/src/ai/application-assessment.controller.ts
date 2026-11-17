import { Body, Controller, Post } from '@nestjs/common';
import { ApplicationAssessmentDto } from './dto/application-assessment.dto';
import { ApplicationAssessmentService } from './application-assessment.service';

@Controller('user/ai')
export class ApplicationAssessmentController {
  constructor(private readonly assessments: ApplicationAssessmentService) {}
  @Post('application-assessment')
  evaluate(@Body() input: ApplicationAssessmentDto) {
    return this.assessments.evaluate(input);
  }
}
